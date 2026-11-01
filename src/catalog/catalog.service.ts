import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { SnapshotKind } from '../generated/prisma/enums';
import {
  AnimeSummaryDto,
  CatalogResponseDto,
  SuggestionResponseDto,
} from '../common/contracts';
import {
  serializeAnime,
  serializeCategory,
  sortByName,
} from '../common/serializers';
import { databaseSchema, PrismaService } from '../prisma/prisma.service';
import {
  bySlug,
  ProjectionService,
  summaryNeedsDetail,
} from '../projection/projection.service';
import {
  ANIMEAV1_CATALOG_PAGE_SIZE,
  isCatalogCapped,
} from '../source/animeav1.constants';
import { AnimeAv1Service } from '../source/animeav1.service';
import { waitForSource } from '../source/source-wait';
import { catalogListing } from './catalog-listing';
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

/** The snapshot recording the last complete catalog pass (CatalogPassScheduler). */
export const CATALOG_PASS_KEY = 'catalog:pass';

const SEARCH_TTL_MINUTES = 30;
/**
 * A search page stored longer ago than this is renewed before answering,
 * within the request's deadline: a quiet query would otherwise hand its next
 * visitor a page from days ago. Younger stale pages are served while they
 * refresh.
 */
const SEARCH_MAX_SERVED_AGE_MS = 2 * SEARCH_TTL_MINUTES * 60_000;

type StoredYears = { min: Date | null; max: Date | null };

/** Years the catalog filter offers: those of the anime stored. */
export function catalogYearRange(stored: StoredYears): [number, number] {
  const thisYear = new Date().getUTCFullYear();
  return [
    stored.min?.getUTCFullYear() ?? thisYear,
    stored.max?.getUTCFullYear() ?? thisYear,
  ];
}

type Freshness = { fetchedAt: Date; nextRefreshAt: Date };

/**
 * The catalog is served from the stored anime, which the daily pass and the
 * detail worker keep in step with the source. Only search asks the source:
 * it matches every alias and ranks by relevance, which we do not store.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly schema: Prisma.Sql;
  // Every query reports the same years: read from the stored anime, shared
  // until a refresh stores more or a TTL passes.
  private storedYears: { value: Promise<StoredYears>; at: number } | null =
    null;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly projection: ProjectionService,
    private readonly source: AnimeAv1Service,
  ) {
    const schema =
      databaseSchema(config.getOrThrow<string>('DATABASE_URL')) ?? 'public';
    this.schema = Prisma.raw(`"${schema.replaceAll('"', '""')}"`);
  }

  getCatalog(query: CatalogQueryDto): Promise<CatalogResponseDto> {
    return query.search?.trim()
      ? this.searchCatalog(query)
      : this.listCatalog(query);
  }

  async getSuggestions(query: string): Promise<SuggestionResponseDto> {
    // The source's default order is newest first: "naru" would bury Naruto.
    const response = await this.getCatalog({
      page: 1,
      search: query.trim(),
      order: 'popular',
    });
    return { data: response.data.slice(0, 8) };
  }

  private async listCatalog(
    query: CatalogQueryDto,
  ): Promise<CatalogResponseDto> {
    const page = query.page ?? 1;
    const sql = catalogListing(this.schema, query);
    const rows = await this.prisma.$queryRaw<{ id: string; total: number }[]>(
      sql.page,
    );
    // Past the last page there are no rows to carry the total.
    const total =
      rows[0]?.total ??
      (page > 1
        ? (await this.prisma.$queryRaw<{ total: number }[]>(sql.count))[0].total
        : 0);
    const [anime, pass] = await Promise.all([
      this.prisma.anime.findMany({
        where: { id: { in: rows.map((row) => row.id) } },
        include: { category: true },
      }),
      this.prisma.snapshot.findUnique({ where: { key: CATALOG_PASS_KEY } }),
    ]);
    const byId = new Map(anime.map((entry) => [entry.id, entry]));
    const data = rows.flatMap((row) => {
      const entry = byId.get(row.id);
      return entry ? [serializeAnime(entry)] : [];
    });
    // Before the first complete pass the stored catalog is as old as it gets.
    const now = new Date();
    return this.respond(
      data,
      {
        page,
        perPage: ANIMEAV1_CATALOG_PAGE_SIZE,
        totalPages: Math.ceil(total / ANIMEAV1_CATALOG_PAGE_SIZE),
        totalRecords: total,
        capped: false,
      },
      pass ?? { fetchedAt: now, nextRefreshAt: now },
    );
  }

  private async searchCatalog(
    query: CatalogQueryDto,
  ): Promise<CatalogResponseDto> {
    const params = this.toParams(query);
    const key = this.snapshotKey(params);
    const page = Number(params.get('page') ?? 1);
    let snapshot = await this.loadSnapshot(key);
    // A cold, degenerate or long-stale cache waits for the source, within the
    // request's deadline; a recently stale one is served while it refreshes.
    if (
      !snapshot ||
      this.isDegenerate(snapshot, page) ||
      Date.now() - snapshot.fetchedAt.getTime() > SEARCH_MAX_SERVED_AGE_MS
    ) {
      try {
        if (await waitForSource(this.refresh(key, params))) {
          snapshot = await this.loadSnapshot(key);
        }
      } catch {
        // Logged by refresh(): the check below decides on what is stored.
      }
    } else if (snapshot.nextRefreshAt <= new Date()) {
      void this.refresh(key, params).catch(() => undefined);
    }
    if (!snapshot || this.isDegenerate(snapshot, page)) {
      throw new ServiceUnavailableException('Catalog data is unavailable.');
    }
    return this.respond(
      snapshot.items.map(({ anime }) => serializeAnime(anime)),
      {
        page,
        perPage: ANIMEAV1_CATALOG_PAGE_SIZE,
        totalPages: snapshot.totalPages ?? 0,
        totalRecords: snapshot.totalRecords ?? 0,
        capped: isCatalogCapped(snapshot.totalRecords),
      },
      snapshot,
    );
  }

  private async respond(
    data: AnimeSummaryDto[],
    counts: Pick<
      CatalogResponseDto['meta'],
      'page' | 'perPage' | 'totalPages' | 'totalRecords' | 'capped'
    >,
    freshness: Freshness,
  ): Promise<CatalogResponseDto> {
    const [categories, genres, storedYears] = await Promise.all([
      this.prisma.category.findMany(),
      this.prisma.genre.findMany(),
      this.loadStoredYears(),
    ]);
    return {
      data,
      meta: {
        ...counts,
        categories: sortByName(categories.map(serializeCategory)),
        genres: sortByName(genres.map(serializeCategory)),
        years: catalogYearRange(storedYears),
        fetchedAt: freshness.fetchedAt.toISOString(),
        nextRefreshAt: freshness.nextRefreshAt.toISOString(),
        stale: freshness.nextRefreshAt <= new Date(),
      },
    };
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
      const stored = await this.projection.findStored(
        source.results.map((entry) => entry.id),
      );
      const anime = await Promise.all(
        source.results.map(async (entry) => {
          if (!summaryNeedsDetail(entry, stored.get(entry.id))) {
            return this.projection.upsertAnime(entry);
          }
          let detail;
          try {
            detail = await this.source.getAnime(entry.slug);
          } catch {
            return this.projection.upsertAnime(entry);
          }
          return this.projection.upsertDetail(detail);
        }),
      );
      await this.projection.replaceSnapshot(
        key,
        SnapshotKind.CATALOG,
        anime.map((entry) => ({ animeId: entry.id })),
        {
          ttlMinutes: SEARCH_TTL_MINUTES,
          totalPages: source.totalPages,
          totalRecords: source.totalRecords,
        },
      );
      // The anime just stored may widen the years.
      this.storedYears = null;
    })();
    // Logged once per flight, whether a request waited for it or not.
    void promise.catch((error: unknown) =>
      this.logger.warn(
        `Catalog refresh failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    const flight = promise.finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, flight);
    return flight;
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

  private loadStoredYears() {
    if (
      !this.storedYears ||
      Date.now() - this.storedYears.at > SEARCH_TTL_MINUTES * 60_000
    ) {
      const value = this.prisma.anime
        .aggregate({
          where: { availability: 'AVAILABLE' },
          _min: { startDate: true },
          _max: { startDate: true },
        })
        .then(({ _min, _max }) => ({
          min: _min.startDate,
          max: _max.startDate,
        }));
      // A failed read is retried by the next request, not shared.
      void value.catch(() => {
        if (this.storedYears?.value === value) this.storedYears = null;
      });
      this.storedYears = { value, at: Date.now() };
    }
    return this.storedYears.value;
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
