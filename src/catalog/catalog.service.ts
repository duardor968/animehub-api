import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SnapshotKind } from '../generated/prisma/enums';
import { CatalogResponseDto, SuggestionResponseDto } from '../common/contracts';
import { serializeAnime, serializeCategory } from '../common/serializers';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { CatalogQueryDto } from './catalog-query.dto';

@Injectable()
export class CatalogService {
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
  ) {}

  async getCatalog(query: CatalogQueryDto): Promise<CatalogResponseDto> {
    const params = this.toParams(query);
    const key = this.snapshotKey(params);
    let snapshot = await this.loadSnapshot(key);
    // A zero-result page is a legitimate outcome for a filtered search, so we
    // must NOT block on emptiness in general. But a snapshot that holds no items
    // yet claims records exist is degenerate (a partial/failed refresh got
    // cached); treat that like a cold cache and fetch synchronously.
    if (!snapshot || this.isDegenerate(snapshot)) {
      try {
        await this.refresh(key, params);
        snapshot = await this.loadSnapshot(key);
      } catch {
        // Source unavailable: keep whatever we already loaded rather than
        // erroring; the guard below still handles a genuinely cold cache.
      }
    } else if (snapshot.nextRefreshAt <= new Date()) {
      void this.refresh(key, params);
    }
    if (!snapshot) {
      throw new ServiceUnavailableException('Catalog data is unavailable.');
    }
    const [categories, genres] = await Promise.all([
      this.prisma.category.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.genre.findMany({ orderBy: { name: 'asc' } }),
    ]);
    const page = Number(params.get('page') ?? 1);
    return {
      data: snapshot.items.map(({ anime }) => serializeAnime(anime)),
      meta: {
        page,
        perPage: 20,
        totalPages: snapshot.totalPages ?? 0,
        totalRecords: snapshot.totalRecords ?? 0,
        categories: categories.map(serializeCategory),
        genres: genres.map(serializeCategory),
        years: [
          snapshot.minYear ?? 1990,
          snapshot.maxYear ?? new Date().getFullYear(),
        ],
        fetchedAt: snapshot.fetchedAt.toISOString(),
        nextRefreshAt: snapshot.nextRefreshAt.toISOString(),
        stale: snapshot.nextRefreshAt <= new Date(),
      },
    };
  }

  async getSuggestions(query: string): Promise<SuggestionResponseDto> {
    const response = await this.getCatalog({ page: 1, search: query.trim() });
    return { data: response.data.slice(0, 8) };
  }

  private refresh(key: string, params: URLSearchParams) {
    const active = this.refreshes.get(key);
    if (active) return active;
    const promise = (async () => {
      const source = await this.source.getCatalog(params);
      // A response that claims records but carries no rows is a partial/failed
      // fetch; caching it would serve an empty grid under a non-zero count. Keep
      // the previous snapshot (if any) and retry next cycle. A genuine 0-result
      // search (totalRecords === 0) still caches normally below.
      if (source.results.length === 0 && source.totalRecords > 0) return;
      await Promise.all([
        ...source.categories.map((category) =>
          this.prisma.category.upsert({
            where: { slug: category.slug },
            update: { sourceId: category.id, name: category.name },
            create: {
              sourceId: category.id,
              name: category.name,
              slug: category.slug,
            },
          }),
        ),
        ...source.genres.map((genre) =>
          this.prisma.genre.upsert({
            where: { slug: genre.slug },
            update: { sourceId: genre.id, name: genre.name },
            create: {
              sourceId: genre.id,
              name: genre.name,
              slug: genre.slug,
            },
          }),
        ),
      ]);
      const enriched = await Promise.all(
        source.results.map(async (entry) => {
          if (entry.startDate && entry.category && entry.synopsis) return entry;
          try {
            return await this.source.getAnime(entry.slug);
          } catch {
            return entry;
          }
        }),
      );
      const anime = await Promise.all(
        enriched.map((entry) => this.projection.upsertAnime(entry)),
      );
      const snapshot = await this.projection.replaceSnapshot(
        key,
        SnapshotKind.CATALOG,
        anime.map((entry) => ({ animeId: entry.id })),
        {
          ttlMinutes: 30,
          totalPages: source.totalPages,
          totalRecords: source.totalRecords,
        },
      );
      await this.prisma.snapshot.update({
        where: { id: snapshot.id },
        data: { minYear: source.years[0], maxYear: source.years[1] },
      });
    })().finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, promise);
    return promise;
  }

  // A snapshot with no items but a positive record count can only come from a
  // partial/failed refresh — page 1 of a non-empty result always has rows.
  private isDegenerate(snapshot: {
    items: unknown[];
    totalRecords: number | null;
  }) {
    return snapshot.items.length === 0 && (snapshot.totalRecords ?? 0) > 0;
  }

  private loadSnapshot(key: string) {
    return this.prisma.snapshot.findUnique({
      where: { key },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: { anime: { include: { category: true } } },
        },
      },
    });
  }

  private toParams(query: CatalogQueryDto) {
    const params = new URLSearchParams();
    params.set('page', String(query.page ?? 1));
    if (query.search?.trim()) params.set('search', query.search.trim());
    if (query.order) params.set('order', query.order);
    if (query.letter) params.set('letter', query.letter.toUpperCase());
    if (query.status) params.set('status', query.status);
    for (const genre of query.genre ?? []) params.append('genre', genre);
    for (const category of query.category ?? [])
      params.append('category', category);
    if (query.minYear) params.set('minYear', String(query.minYear));
    if (query.maxYear) params.set('maxYear', String(query.maxYear));
    params.sort();
    return params;
  }

  private snapshotKey(params: URLSearchParams) {
    return `catalog:${createHash('sha256').update(params.toString()).digest('hex')}`;
  }
}
