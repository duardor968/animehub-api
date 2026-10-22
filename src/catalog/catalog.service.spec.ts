import { ServiceUnavailableException } from '@nestjs/common';
import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { SOURCE_WAIT_MS } from '../source/source-wait';
import type { SourceCatalog } from '../source/source.types';
import { CatalogService, isDegenerateCatalogPage } from './catalog.service';

it('persists the relation graph fetched while enriching a new catalog entry', async () => {
  const entry = {
    id: 'new',
    slug: 'new',
    title: 'New',
    synopsis: null,
    posterUrl: 'https://cdn.test/new.jpg',
    backdropUrl: 'https://cdn.test/new.jpg',
    category: null,
    genres: [],
    status: 'AIRING' as const,
    startDate: null,
    mature: false,
  };
  const detail = {
    ...entry,
    alternativeTitle: null,
    trailerUrl: null,
    endDate: null,
    nextEpisodeAt: null,
    episodeCount: 1,
    score: null,
    votes: null,
    episodes: [],
    relations: [
      { kind: 'PREQUEL' as const, anime: { ...entry, id: 'old', slug: 'old' } },
    ],
  };
  const snapshot = {
    items: [{ anime: { ...entry, sourceId: entry.id } }],
    fetchedAt: new Date(),
    nextRefreshAt: new Date(Date.now() + 60_000),
    totalPages: 1,
    totalRecords: 1,
    minYear: 1990,
    maxYear: 2026,
  };
  const prisma = {
    snapshot: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(snapshot),
    },
    category: { findMany: vi.fn().mockResolvedValue([]) },
    genre: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const projection = {
    upsertAnime: vi.fn(),
    upsertDetail: vi.fn().mockResolvedValue({ id: 'db-new' }),
    replaceSnapshot: vi.fn().mockResolvedValue({}),
  };
  const source = {
    getCatalog: vi.fn().mockResolvedValue({
      results: [entry],
      totalRecords: 1,
      totalPages: 1,
      categories: [],
      genres: [],
      years: [1990, 2026],
    }),
    getAnime: vi.fn().mockResolvedValue(detail),
  };
  const service = new CatalogService(
    prisma as unknown as PrismaService,
    projection as unknown as ProjectionService,
    source as unknown as AnimeAv1Service,
  );
  const response = await service.getCatalog({ page: 1 });
  expect(response.data[0].slug).toBe('new');
  expect(projection.upsertDetail).toHaveBeenCalledWith(detail);
  expect(projection.upsertAnime).not.toHaveBeenCalled();
});

describe('catalog page integrity policy', () => {
  it('rejects an empty in-range page with a positive total as degraded', () => {
    expect(isDegenerateCatalogPage(0, 1_000, 50, 50)).toBe(true);
  });

  it('accepts an empty page beyond the advertised final page', () => {
    expect(isDegenerateCatalogPage(0, 1_000, 50, 51)).toBe(false);
  });

  it('accepts a genuine zero-result query', () => {
    expect(isDegenerateCatalogPage(0, 0, 0, 1)).toBe(false);
  });
});

describe('CatalogService out-of-range pages', () => {
  it('caches and returns an empty out-of-range page instead of a false 503', async () => {
    let snapshot: {
      id: string;
      items: [];
      totalPages: number;
      totalRecords: number;
      minYear: number;
      maxYear: number;
      fetchedAt: Date;
      nextRefreshAt: Date;
    } | null = null;
    const sourcePage: SourceCatalog = {
      results: [],
      page: 51,
      perPage: 20,
      totalPages: 50,
      totalRecords: 1_000,
      categories: [],
      genres: [],
      years: [1990, 2026],
    };
    const prisma = {
      snapshot: {
        findUnique: vi.fn(() => Promise.resolve(snapshot)),
        update: vi.fn(() => Promise.resolve(snapshot)),
      },
      category: {
        findMany: vi.fn(() => Promise.resolve([])),
        upsert: vi.fn(),
      },
      genre: {
        findMany: vi.fn(() => Promise.resolve([])),
        upsert: vi.fn(),
      },
    };
    const projection = {
      replaceSnapshot: vi.fn(() => {
        snapshot = {
          id: 'catalog-page-51',
          items: [],
          totalPages: sourcePage.totalPages,
          totalRecords: sourcePage.totalRecords,
          minYear: sourcePage.years[0],
          maxYear: sourcePage.years[1],
          fetchedAt: new Date(),
          nextRefreshAt: new Date(Date.now() + 30 * 60_000),
        };
        return Promise.resolve(snapshot);
      }),
      upsertAnime: vi.fn(),
    };
    const source = {
      getCatalog: vi.fn(() => Promise.resolve(sourcePage)),
      getAnime: vi.fn(),
    };
    const service = new CatalogService(
      prisma as unknown as PrismaService,
      projection as unknown as ProjectionService,
      source as unknown as AnimeAv1Service,
    );

    const response = await service.getCatalog({ page: 51 });

    expect(response.data).toEqual([]);
    expect(response.meta.page).toBe(51);
    expect(response.meta.totalPages).toBe(50);
    expect(response.meta.capped).toBe(true);
    expect(source.getCatalog).toHaveBeenCalledTimes(1);
  });

  it('reports uncapped totals and orders genres with Spanish collation', async () => {
    const snapshot = {
      id: 'recent',
      items: [],
      totalPages: 37,
      totalRecords: 731,
      minYear: 2024,
      maxYear: 2026,
      fetchedAt: new Date(),
      nextRefreshAt: new Date(Date.now() + 30 * 60_000),
    };
    const genre = (name: string, slug: string) => ({
      sourceId: slug,
      name,
      slug,
    });
    const prisma = {
      snapshot: { findUnique: vi.fn(() => Promise.resolve(snapshot)) },
      category: { findMany: vi.fn(() => Promise.resolve([])) },
      genre: {
        findMany: vi.fn(() =>
          Promise.resolve([
            genre('Vampiros', 'vampiros'),
            genre('Ciencia Ficción', 'ciencia-ficcion'),
            genre('Ánime Clásico', 'anime-clasico'),
            genre('Acción', 'accion'),
            genre('Comedia', 'comedia'),
          ]),
        ),
      },
    };
    const service = new CatalogService(
      prisma as unknown as PrismaService,
      {} as ProjectionService,
      {} as AnimeAv1Service,
    );

    const response = await service.getCatalog({ page: 99, minYear: 2024 });

    expect(response.meta).toMatchObject({
      totalRecords: 731,
      capped: false,
      perPage: 20,
    });
    expect(response.meta.genres.map((g) => g.name)).toEqual([
      'Acción',
      'Ánime Clásico',
      'Ciencia Ficción',
      'Comedia',
      'Vampiros',
    ]);
  });

  it('does not return a false empty success when an in-range refresh remains degenerate', async () => {
    const fetchedAt = new Date(Date.now() - 60 * 60_000);
    const snapshot = {
      id: 'degenerate-page-1',
      items: [],
      totalPages: 50,
      totalRecords: 1_000,
      minYear: 1990,
      maxYear: 2026,
      fetchedAt,
      nextRefreshAt: new Date(fetchedAt.getTime() + 30 * 60_000),
    };
    const sourcePage: SourceCatalog = {
      results: [],
      page: 1,
      perPage: 20,
      totalPages: 50,
      totalRecords: 1_000,
      categories: [],
      genres: [],
      years: [1990, 2026],
    };
    const prisma = {
      snapshot: {
        findUnique: vi.fn(() => Promise.resolve(snapshot)),
        update: vi.fn(),
      },
      category: { findMany: vi.fn(), upsert: vi.fn() },
      genre: { findMany: vi.fn(), upsert: vi.fn() },
    };
    const projection = {
      replaceSnapshot: vi.fn(),
      upsertAnime: vi.fn(),
    };
    const source = {
      getCatalog: vi.fn(() => Promise.resolve(sourcePage)),
      getAnime: vi.fn(),
    };
    const service = new CatalogService(
      prisma as unknown as PrismaService,
      projection as unknown as ProjectionService,
      source as unknown as AnimeAv1Service,
    );

    await expect(service.getCatalog({ page: 1 })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.snapshot.findUnique).toHaveBeenCalledTimes(2);
    expect(projection.replaceSnapshot).not.toHaveBeenCalled();
    expect(prisma.category.findMany).not.toHaveBeenCalled();
  });
});

describe('CatalogService source deadline', () => {
  afterEach(() => vi.useRealTimers());

  function hangingSource(snapshot: object | null) {
    const prisma = {
      snapshot: { findUnique: vi.fn(() => Promise.resolve(snapshot)) },
      category: { findMany: vi.fn(() => Promise.resolve([])) },
      genre: { findMany: vi.fn(() => Promise.resolve([])) },
    };
    const source = { getCatalog: vi.fn(() => new Promise(() => {})) };
    const service = new CatalogService(
      prisma as unknown as PrismaService,
      {} as ProjectionService,
      source as unknown as AnimeAv1Service,
    );
    return { service, source };
  }

  it('answers 503 at the deadline when nothing is stored', async () => {
    vi.useFakeTimers();
    const { service, source } = hangingSource(null);

    const outcome = expect(
      service.getCatalog({ page: 1, search: 'zombie' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.advanceTimersByTimeAsync(SOURCE_WAIT_MS);

    await outcome;
    expect(source.getCatalog).toHaveBeenCalledOnce();
  });

  it('serves a stale page at once while it refreshes', async () => {
    const { service, source } = hangingSource({
      id: 'stale',
      items: [],
      totalPages: 0,
      totalRecords: 0,
      minYear: 1990,
      maxYear: 2026,
      fetchedAt: new Date(Date.now() - 60 * 60_000),
      nextRefreshAt: new Date(Date.now() - 30 * 60_000),
    });

    const response = await service.getCatalog({ page: 1, search: 'zombie' });

    expect(response.meta.stale).toBe(true);
    expect(source.getCatalog).toHaveBeenCalledOnce();
  });
});

describe('CatalogService suggestions', () => {
  it('suggests the most popular matches first, eight at most', async () => {
    const service = new CatalogService(
      {} as PrismaService,
      {} as ProjectionService,
      {} as AnimeAv1Service,
    );
    const data = Array.from({ length: 20 }, (_, index) => ({ id: `${index}` }));
    const getCatalog = vi
      .spyOn(service, 'getCatalog')
      .mockResolvedValue({ data } as never);

    const response = await service.getSuggestions(' naru ');

    expect(getCatalog).toHaveBeenCalledWith({
      page: 1,
      search: 'naru',
      order: 'popular',
    });
    expect(response.data).toEqual(data.slice(0, 8));
  });
});
