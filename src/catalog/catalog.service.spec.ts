import { ServiceUnavailableException } from '@nestjs/common';
import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import type { SourceCatalog } from '../source/source.types';
import { CatalogService, isDegenerateCatalogPage } from './catalog.service';

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
    expect(source.getCatalog).toHaveBeenCalledTimes(1);
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
