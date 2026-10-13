import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SnapshotKind } from '../generated/prisma/enums';
import { CatalogResponseDto, SuggestionResponseDto } from '../common/contracts';
import {
  serializeAnime,
  serializeCategory,
  sortByName,
} from '../common/serializers';
import { PrismaService } from '../prisma/prisma.service';
import { bySlug, ProjectionService } from '../projection/projection.service';
import {
  ANIMEAV1_CATALOG_PAGE_SIZE,
  isCatalogCapped,
} from '../source/animeav1.constants';
import { AnimeAv1Service } from '../source/animeav1.service';
import { waitForSource } from '../source/source-wait';
import { CatalogQueryDto } from './catalog-query.dto';

/**
 * An empty page that claims records within the advertised pages: a partial or
 * failed source response, never cached nor served. A zero-record search and
 * an empty page beyond the last one are legitimate empty results.
 */
export function isDegenerateCatalogPage(
  itemCount: number,
  totalRecords: number | null,
  totalPages: number | null,
  requestedPage: number,
) {
  if (itemCount > 0 || (totalRecords ?? 0) === 0) return false;
  return (totalPages ?? 0) === 0 || requestedPage <= (totalPages ?? 0);
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
  ) {}

  async getCatalog(query: CatalogQueryDto): Promise<CatalogResponseDto> {
    const params = this.toParams(query);
    const key = this.snapshotKey(params);
    const page = Number(params.get('page') ?? 1);
    let snapshot = await this.loadSnapshot(key);
    // A cold or degenerate cache waits for the source, within the request's
    // deadline; a stale one is served while it refreshes in the background.
    if (!snapshot || this.isDegenerate(snapshot, page)) {
      try {
        if (await waitForSource(this.refresh(key, params))) {
          snapshot = await this.loadSnapshot(key);
        }
      } catch {
        // Source unavailable: the check below decides on what is stored.
      }
    } else if (snapshot.nextRefreshAt <= new Date()) {
      this.refreshInBackground(key, params);
    }
    if (!snapshot || this.isDegenerate(snapshot, page)) {
      throw new ServiceUnavailableException('Catalog data is unavailable.');
    }
    const [categories, genres] = await Promise.all([
      this.prisma.category.findMany(),
      this.prisma.genre.findMany(),
    ]);
    return {
      data: snapshot.items.map(({ anime }) => serializeAnime(anime)),
      meta: {
        page,
        perPage: ANIMEAV1_CATALOG_PAGE_SIZE,
        totalPages: snapshot.totalPages ?? 0,
        totalRecords: snapshot.totalRecords ?? 0,
        capped: isCatalogCapped(snapshot.totalRecords),
        categories: sortByName(categories.map(serializeCategory)),
        genres: sortByName(genres.map(serializeCategory)),
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
      const requestedPage = Number(params.get('page') ?? 1);
      if (
        isDegenerateCatalogPage(
          source.results.length,
          source.totalRecords,
          source.totalPages,
          requestedPage,
        )
      ) {
        this.logger.warn(
          `Degenerate catalog refresh for page ${requestedPage}; keeping the last good snapshot.`,
        );
        return;
      }
      await Promise.all([
        ...source.categories.map((category) =>
          this.prisma.category.upsert(bySlug(category)),
        ),
        ...source.genres.map((genre) =>
          this.prisma.genre.upsert(bySlug(genre)),
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
      await this.projection.replaceSnapshot(
        key,
        SnapshotKind.CATALOG,
        anime.map((entry) => ({ animeId: entry.id })),
        {
          ttlMinutes: 30,
          totalPages: source.totalPages,
          totalRecords: source.totalRecords,
          minYear: source.years[0],
          maxYear: source.years[1],
        },
      );
    })().finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, promise);
    return promise;
  }

  private isDegenerate(
    snapshot: {
      items: unknown[];
      totalRecords: number | null;
      totalPages: number | null;
    },
    requestedPage: number,
  ) {
    return isDegenerateCatalogPage(
      snapshot.items.length,
      snapshot.totalRecords,
      snapshot.totalPages,
      requestedPage,
    );
  }

  private refreshInBackground(key: string, params: URLSearchParams) {
    void this.refresh(key, params).catch((error) => {
      this.logger.warn(
        `Catalog refresh failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
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
