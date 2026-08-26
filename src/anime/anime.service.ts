import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AnimeResponseDto, EpisodePageResponseDto } from '../common/contracts';
import { serializeDetail, serializeEpisode } from '../common/serializers';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
} from '../source/animeav1.service';

const detailInclude = {
  category: true,
  genres: { include: { genre: true } },
  outgoingRelations: {
    orderBy: { position: 'asc' as const },
    include: { targetAnime: { include: { category: true } } },
  },
};

export const ANIME_REQUEST_REFRESH_TIMEOUT_MS = 10_000;

@Injectable()
export class AnimeService {
  private readonly logger = new Logger(AnimeService.name);
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
  ) {}

  async getAnime(slug: string): Promise<AnimeResponseDto> {
    let anime = await this.prisma.anime.findUnique({
      where: { slug },
      include: detailInclude,
    });
    if (!anime) {
      await this.refresh(slug);
      anime = await this.prisma.anime.findUnique({
        where: { slug },
        include: detailInclude,
      });
    } else if (!anime.detailFetchedAt) {
      await this.waitForRefresh(this.refresh(slug), slug);
      anime = await this.prisma.anime.findUnique({
        where: { slug },
        include: detailInclude,
      });
    } else if (anime.nextRefreshAt <= new Date()) {
      this.refreshInBackground(slug, 'expired detail');
    }
    if (!anime) throw new NotFoundException('Anime not found.');
    if (anime.availability === 'UNAVAILABLE') {
      throw new NotFoundException(
        'Anime is no longer available at the source.',
      );
    }
    // The source omits synopsis/category from relation references, so a related
    // title only has them once it has been detailed on its own. Backfill any
    // that haven't been — non-blocking and deduped — so every related card can
    // consistently reveal its description on a later view.
    for (const relation of anime.outgoingRelations) {
      const target = relation.targetAnime;
      if (target && !target.detailFetchedAt) {
        this.refreshInBackground(target.slug, 'related detail backfill');
      }
    }
    return {
      data: serializeDetail(anime),
      meta: {
        fetchedAt: (anime.detailFetchedAt ?? anime.lastFetchedAt).toISOString(),
        nextRefreshAt: anime.nextRefreshAt.toISOString(),
        stale: anime.nextRefreshAt <= new Date(),
      },
    };
  }

  async getEpisodes(
    slug: string,
    page: number,
  ): Promise<EpisodePageResponseDto> {
    let anime = await this.prisma.anime.findUnique({ where: { slug } });
    if (!anime) {
      await this.refresh(slug);
      anime = await this.prisma.anime.findUnique({ where: { slug } });
    } else if (!anime.detailFetchedAt) {
      await this.waitForRefresh(this.refresh(slug), slug);
      anime = await this.prisma.anime.findUnique({ where: { slug } });
    }
    if (!anime) throw new NotFoundException('Anime not found.');
    if (anime.availability === 'UNAVAILABLE') {
      throw new NotFoundException(
        'Anime is no longer available at the source.',
      );
    }
    // Episode availability is the fast-moving part of an airing title. getAnime
    // normally revalidates stale details in the background, but querying the
    // episode table before that refresh completes recreates the same "first
    // visitor sees the old episode list" bug as Home. Await the existing
    // single-flight refresh for airing series, with a bounded last-good fallback.
    const now = new Date();
    const premiereIsDue =
      anime.status === 'UPCOMING' &&
      anime.nextEpisodeAt !== null &&
      anime.nextEpisodeAt <= now;
    const canStillGainEpisodes = anime.status !== 'FINISHED';
    if (canStillGainEpisodes && (anime.nextRefreshAt <= now || premiereIsDue)) {
      await this.waitForRefresh(this.refresh(slug), slug);
      anime = await this.prisma.anime.findUniqueOrThrow({ where: { slug } });
    }
    const perPage = 50;
    const [episodes, totalRecords] = await Promise.all([
      this.prisma.episode.findMany({
        where: { animeId: anime.id },
        orderBy: { number: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.episode.count({ where: { animeId: anime.id } }),
    ]);
    return {
      data: episodes.map(serializeEpisode),
      meta: {
        page,
        perPage,
        totalPages: Math.ceil(totalRecords / perPage),
        totalRecords,
      },
    };
  }

  async ensureAnime(slug: string) {
    await this.getAnime(slug);
    return this.prisma.anime.findUniqueOrThrow({ where: { slug } });
  }

  private refresh(slug: string) {
    const active = this.refreshes.get(slug);
    if (active) return active;
    const promise = (async () => {
      try {
        const source = await this.source.getAnime(slug);
        await this.projection.upsertDetail(source);
      } catch (error) {
        if (error instanceof AnimeAv1NotFoundError) {
          await this.projection.markNotFound(slug);
          const cached = await this.prisma.anime.findUnique({
            where: { slug },
          });
          if (!cached) throw new NotFoundException('Anime not found.');
          return;
        }
        const cached = await this.prisma.anime.findUnique({ where: { slug } });
        if (!cached) {
          throw new ServiceUnavailableException(
            'AnimeAV1 is temporarily unavailable.',
          );
        }
        // A cached record is the fallback, not evidence that the refresh
        // succeeded. Propagate so the request-side bounded wait or background
        // catch can log the source failure before serving that cached record.
        throw error;
      }
    })().finally(() => this.refreshes.delete(slug));
    this.refreshes.set(slug, promise);
    return promise;
  }

  private refreshInBackground(slug: string, operation: string) {
    void this.refresh(slug).catch((error) => {
      this.logger.warn(
        `${operation} refresh failed for ${slug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async waitForRefresh(promise: Promise<void>, slug: string) {
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      promise.then(
        () => ({ kind: 'completed' as const }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
      new Promise<{ kind: 'timed-out' }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: 'timed-out' }),
          ANIME_REQUEST_REFRESH_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.kind === 'completed') return;
    this.logger.warn(
      outcome.kind === 'timed-out'
        ? `Episode refresh timed out for ${slug}; serving cached episodes.`
        : `Episode refresh failed for ${slug}; serving cached episodes: ${
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error)
          }`,
    );
  }
}
