import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unflatten } from 'devalue';
import pLimit from 'p-limit';
import { z } from 'zod';
import {
  SourceAnimeDetail,
  SourceAnimeSummary,
  SourceCatalog,
  SourceCategory,
  SourceDownloadLink,
  SourceEpisode,
  SourceEpisodeDownloads,
  SourceHome,
  SourceRelation,
  SourceScheduleEntry,
  SourceStatus,
} from './source.types';

const envelopeSchema = z.object({
  type: z.literal('data'),
  nodes: z.array(z.unknown()),
});

const categorySchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    slug: z.string().optional(),
  })
  .passthrough();

const animeSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    slug: z.string(),
    title: z.string(),
    synopsis: z.string().nullish(),
    category: categorySchema.nullish(),
    genres: z.array(categorySchema).optional(),
    status: z.number().optional(),
    startDate: z.string().nullish(),
    mature: z.boolean().optional(),
  })
  .passthrough();

const episodeSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    number: z.number(),
    title: z.string().nullish(),
    publishedAt: z.string().nullish(),
    createdAt: z.string().nullish(),
  })
  .passthrough();

const homeSchema = z
  .object({
    featured: z.array(animeSchema),
    latestEpisodes: z.array(
      episodeSchema.extend({
        media: animeSchema,
      }),
    ),
    latestMedia: z.array(animeSchema),
  })
  .passthrough();

const catalogSchema = z
  .object({
    results: z.array(animeSchema),
    categoriesIdsMap: z.record(z.string(), categorySchema),
    genresIdsMap: z.record(z.string(), categorySchema),
    years: z.tuple([z.number(), z.number()]),
    pagination: z.object({
      currentPage: z.number(),
      recordsPerPage: z.number(),
      totalPages: z.number(),
      totalRecords: z.number(),
    }),
  })
  .passthrough();

const animeDetailSchema = z.object({
  media: animeSchema.extend({
    aka: z.record(z.string(), z.string()).nullish(),
    trailer: z.string().nullish(),
    endDate: z.string().nullish(),
    nextDate: z.string().nullish(),
    episodesCount: z.number().nullish(),
    score: z.number().nullish(),
    votes: z.number().nullish(),
    episodes: z.array(episodeSchema),
    relations: z
      .array(
        z.object({
          type: z.number(),
          destination: animeSchema,
        }),
      )
      .optional(),
  }),
});

const episodeDownloadsSchema = z.object({
  media: animeSchema,
  episode: episodeSchema,
  downloads: z.record(
    z.string(),
    z.array(z.object({ server: z.string(), url: z.url() })),
  ),
});

const scheduleSchema = z.object({
  media: z.array(
    animeSchema.extend({
      latestEpisode: episodeSchema.nullish(),
    }),
  ),
});

export class AnimeAv1NotFoundError extends Error {}
export class AnimeAv1UnavailableError extends Error {}

@Injectable()
export class AnimeAv1Service {
  private readonly logger = new Logger(AnimeAv1Service.name);
  private readonly limit = pLimit(16);
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('ANIMEAV1_BASE_URL', 'https://animeav1.com')
      .replace(/\/$/, '');
    this.userAgent = config.get<string>(
      'SOURCE_USER_AGENT',
      'AnimeHub/1.0 (+https://github.com/duardor968/animehub-web)',
    );
  }

  async getHome(): Promise<SourceHome> {
    const data = homeSchema.parse(await this.fetchRoute('/'));
    return {
      featured: data.featured.map((anime) => this.normalizeAnime(anime)),
      recentEpisodes: data.latestEpisodes.map((episode) => ({
        anime: this.normalizeAnime(episode.media),
        episode: this.normalizeEpisode(
          episode,
          episode.media.slug,
          String(episode.media.id),
        ),
      })),
      recentAnime: data.latestMedia.map((anime) => this.normalizeAnime(anime)),
    };
  }

  async getCatalog(params: URLSearchParams): Promise<SourceCatalog> {
    const data = catalogSchema.parse(
      await this.fetchRoute('/catalogo', params),
    );
    return {
      results: data.results.map((anime) => this.normalizeAnime(anime)),
      page: data.pagination.currentPage,
      perPage: data.pagination.recordsPerPage,
      totalPages: data.pagination.totalPages,
      totalRecords: data.pagination.totalRecords,
      categories: Object.values(data.categoriesIdsMap).map((category) =>
        this.normalizeCategory(category),
      ),
      genres: Object.values(data.genresIdsMap).map((genre) =>
        this.normalizeCategory(genre),
      ),
      years: data.years,
    };
  }

  async getAnime(slug: string): Promise<SourceAnimeDetail> {
    const data = animeDetailSchema.parse(
      await this.fetchRoute(`/media/${encodeURIComponent(slug)}`),
    );
    const media = data.media;
    const aliases = media.aka ? Object.values(media.aka).filter(Boolean) : [];
    return {
      ...this.normalizeAnime(media),
      alternativeTitle: aliases[0] ?? null,
      trailerUrl: media.trailer
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(media.trailer)}`
        : null,
      endDate: this.toDate(media.endDate),
      nextEpisodeAt: this.toDate(media.nextDate),
      episodeCount: media.episodesCount ?? null,
      score: media.score ?? null,
      votes: media.votes ?? null,
      episodes: media.episodes.map((episode) =>
        this.normalizeEpisode(episode, media.slug, String(media.id)),
      ),
      relations: (media.relations ?? []).map((relation) =>
        this.normalizeRelation(relation.type, relation.destination),
      ),
    };
  }

  async getSchedule(): Promise<SourceScheduleEntry[]> {
    const data = scheduleSchema.parse(await this.fetchRoute('/horario'));
    // Return the full roster the source listed — including shows whose latest
    // episode is momentarily absent (episode: null) — so the count reflects the
    // real roster size for the projection's degraded-scrape guard, and no show is
    // dropped here on a transient blip.
    return data.media.map((anime) => ({
      anime: this.normalizeAnime(anime),
      episode: anime.latestEpisode
        ? this.normalizeEpisode(
            anime.latestEpisode,
            anime.slug,
            String(anime.id),
          )
        : null,
    }));
  }

  async getEpisodeDownloads(
    slug: string,
    number: number,
  ): Promise<SourceEpisodeDownloads> {
    const data = episodeDownloadsSchema.parse(
      await this.fetchRoute(
        `/media/${encodeURIComponent(slug)}/${encodeURIComponent(String(number))}`,
      ),
    );
    const links: SourceDownloadLink[] = [];
    for (const [audioName, entries] of Object.entries(data.downloads)) {
      const audio = audioName.toUpperCase();
      if (audio !== 'SUB' && audio !== 'DUB') continue;
      for (const entry of entries) {
        const provider = this.normalizeProvider(entry.server);
        if (provider) links.push({ audio, provider, url: entry.url });
      }
    }
    return {
      anime: this.normalizeAnime(data.media),
      episode: this.normalizeEpisode(
        data.episode,
        data.media.slug,
        String(data.media.id),
      ),
      links,
    };
  }

  private async fetchRoute(
    path: string,
    params = new URLSearchParams(),
  ): Promise<unknown> {
    const dataPath = path === '/' ? '/__data.json' : `${path}/__data.json`;
    const query = params.toString();
    const url = `${this.baseUrl}${dataPath}${query ? `?${query}` : ''}`;
    return this.limit(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(url, {
            headers: {
              accept: 'application/json',
              'user-agent': this.userAgent,
            },
            signal: AbortSignal.timeout(12_000),
          });
          if (response.status === 404) throw new AnimeAv1NotFoundError(path);
          if (!response.ok) {
            if (![429, 503].includes(response.status)) {
              throw new AnimeAv1UnavailableError(
                `Source status ${response.status}`,
              );
            }
            throw new Error(`Retryable source status ${response.status}`);
          }
          const envelope = envelopeSchema.parse(await response.json());
          const node = [...envelope.nodes]
            .reverse()
            .find((value): value is { type: 'data'; data: unknown[] } =>
              Boolean(
                value &&
                typeof value === 'object' &&
                'type' in value &&
                value.type === 'data' &&
                'data' in value &&
                Array.isArray(value.data),
              ),
            );
          if (!node) throw new AnimeAv1UnavailableError('Missing route data');
          return unflatten(node.data) as unknown;
        } catch (error) {
          if (error instanceof AnimeAv1NotFoundError) throw error;
          lastError = error;
          if (attempt < 2) {
            await new Promise((resolve) =>
              setTimeout(resolve, 350 * 2 ** attempt + Math.random() * 200),
            );
          }
        }
      }
      this.logger.warn(`AnimeAV1 request failed for ${path}`);
      throw new AnimeAv1UnavailableError(
        lastError instanceof Error ? lastError.message : 'Source unavailable',
      );
    });
  }

  private normalizeAnime(
    input: z.infer<typeof animeSchema>,
  ): SourceAnimeSummary {
    const id = String(input.id);
    return {
      id,
      slug: input.slug,
      title: input.title,
      synopsis: input.synopsis?.trim() || null,
      posterUrl: `https://cdn.animeav1.com/covers/${id}.jpg`,
      backdropUrl: `https://cdn.animeav1.com/backdrops/${id}.jpg`,
      category: input.category ? this.normalizeCategory(input.category) : null,
      genres: (input.genres ?? []).map((genre) =>
        this.normalizeCategory(genre),
      ),
      status: this.normalizeStatus(input.status, input.startDate),
      startDate: this.toDate(input.startDate),
      mature: input.mature ?? false,
    };
  }

  private normalizeEpisode(
    input: z.infer<typeof episodeSchema>,
    slug: string,
    animeId: string,
  ): SourceEpisode {
    return {
      id: String(input.id),
      number: input.number,
      title: input.title?.trim() || null,
      imageUrl: `https://cdn.animeav1.com/screenshots/${animeId}/${input.number}.jpg`,
      sourcePath: `/media/${slug}/${input.number}`,
      publishedAt: this.toDate(input.publishedAt ?? input.createdAt),
    };
  }

  private normalizeCategory(
    input: z.infer<typeof categorySchema>,
  ): SourceCategory {
    return {
      id: String(input.id),
      name: input.name,
      slug: input.slug ?? this.slugify(input.name),
    };
  }

  private normalizeStatus(
    status: number | undefined,
    startDate?: string | null,
  ): SourceStatus {
    if (status === 0) return 'FINISHED';
    if (status === 2) return 'AIRING';
    const startsAt = this.toDate(startDate);
    if (startsAt && startsAt > new Date()) return 'UPCOMING';
    return 'UNKNOWN';
  }

  private normalizeRelation(
    type: number,
    destination: z.infer<typeof animeSchema>,
  ): SourceRelation {
    // AnimeAV1 relation type codes, taken from its own client bundle:
    // 1 Precuela · 2 Secuela · 3 Ambientación alternativa · 4 Versión alternativa
    // 5 Historia paralela · 6 Resumen · 7 Historia completa · 8 Historia principal
    // 9 Spin-off. Our RelationKind enum is coarser, so several map to the nearest
    // value (both alternatives → ALTERNATIVE; full/main story → MAIN_STORY;
    // spin-off has no equivalent → OTHER).
    const kinds: Record<number, SourceRelation['kind']> = {
      1: 'PREQUEL',
      2: 'SEQUEL',
      3: 'ALTERNATIVE',
      4: 'ALTERNATIVE',
      5: 'SIDE_STORY',
      6: 'SUMMARY',
      7: 'MAIN_STORY',
      8: 'MAIN_STORY',
    };
    return {
      kind: kinds[type] ?? 'OTHER',
      anime: this.normalizeAnime(destination),
    };
  }

  private normalizeProvider(
    server: string,
  ): SourceDownloadLink['provider'] | null {
    const normalized = server.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.includes('mega')) return 'MEGA';
    if (normalized.includes('pixeldrain') || normalized.includes('pdrain')) {
      return 'PIXELDRAIN';
    }
    if (normalized.includes('mp4upload')) return 'MP4UPLOAD';
    if (normalized.includes('1fichier') || normalized.includes('onefichier')) {
      return 'ONE_FICHIER';
    }
    return null;
  }

  private toDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private slugify(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
}
