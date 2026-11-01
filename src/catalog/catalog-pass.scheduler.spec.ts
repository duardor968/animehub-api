import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
} from '../source/animeav1.service';
import type { SourceCatalog } from '../source/source.types';
import { CatalogPassScheduler, yearRanges } from './catalog-pass.scheduler';
import { CATALOG_PASS_KEY } from './catalog.service';

// The pauses resolve at once; each is recorded.
const pause = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('node:timers/promises', () => ({ setTimeout: pause }));

const listed = (id: string) => ({
  id,
  slug: `anime-${id}`,
  title: id,
  synopsis: null,
  posterUrl: '',
  backdropUrl: '',
  category: null,
  genres: [],
  status: 'UNKNOWN' as const,
  startDate: null,
  mature: null,
});
const page = (
  results: ReturnType<typeof listed>[],
  totalRecords = results.length,
): SourceCatalog => ({
  results,
  page: 1,
  perPage: 20,
  totalPages: Math.ceil(totalRecords / 20),
  totalRecords,
  categories: [{ id: '1', name: 'TV Anime', slug: 'tv-anime' }],
  genres: [],
  years: [1990, 2026],
});

function harness(
  answer: (params: URLSearchParams) => Promise<SourceCatalog>,
  leased = true,
) {
  const prisma = {
    homeRefreshLease: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi
        .fn()
        .mockResolvedValueOnce({ count: leased ? 1 : 0 })
        .mockResolvedValue({ count: 1 }),
    },
    anime: {
      // Stored and available, but no longer listed.
      findMany: vi.fn().mockResolvedValue([{ slug: 'anime-gone' }]),
    },
    category: { upsert: vi.fn() },
    genre: { upsert: vi.fn() },
  };
  const inFlight = { now: 0, max: 0 };
  const source = {
    getCatalog: vi.fn(async (params: URLSearchParams) => {
      inFlight.max = Math.max(inFlight.max, ++inFlight.now);
      try {
        return await answer(params);
      } finally {
        inFlight.now--;
      }
    }),
    getAnime: vi.fn(() =>
      Promise.reject(new AnimeAv1NotFoundError('/media/anime-gone')),
    ),
  };
  const projection = {
    upsertAnime: vi.fn().mockResolvedValue({}),
    upsertDetail: vi.fn(),
    markNotFound: vi.fn().mockResolvedValue(undefined),
    replaceSnapshot: vi.fn().mockResolvedValue({}),
  };
  const scheduler = new CatalogPassScheduler(
    new ConfigService({ JOBS_ENABLED: 'false' }),
    prisma as unknown as PrismaService,
    source as unknown as AnimeAv1Service,
    projection as unknown as ProjectionService,
  );
  const run = () => scheduler.runDue();
  const nextAttemptIn = () => {
    const release = prisma.homeRefreshLease.updateMany.mock.calls.at(-1) as [
      { data: { nextAttemptAt: Date } },
    ];
    return release[0].data.nextAttemptAt.getTime() - Date.now();
  };
  return { prisma, source, projection, run, nextAttemptIn, inFlight };
}

const lastYear = new Date().getUTCFullYear() + 1;
const ranges = yearRanges(lastYear).length;

describe('catalog pass', () => {
  beforeEach(() => pause.mockClear());

  it('covers every year in ranges under the source cap', () => {
    expect(yearRanges(2027)[0]).toEqual([1900, 1989]);
    expect(yearRanges(2027).at(-1)).toEqual([2027, 2027]);
    expect(yearRanges(2027)).toHaveLength(39);
  });

  it('walks every page of every range, one request at a time, and records a complete pass', async () => {
    const twoPages = Array.from({ length: 21 }, (_, index) =>
      listed(`${index}`),
    );
    const h = harness((params) => {
      if (params.get('minYear') !== '2024') return Promise.resolve(page([]));
      return Promise.resolve(
        params.get('page') === '1'
          ? page(twoPages.slice(0, 20), 21)
          : page(twoPages.slice(20), 21),
      );
    });
    await h.run();

    expect(h.source.getCatalog).toHaveBeenCalledTimes(ranges + 1);
    expect(h.source.getCatalog.mock.calls[0][0].toString()).toBe(
      'maxYear=1989&minYear=1900&order=latest_added&page=1',
    );
    // A pause after each of the listing pages and the one detail check.
    expect(pause).toHaveBeenCalledTimes(ranges + 2);
    expect(h.inFlight.max).toBe(1);
    expect(h.projection.upsertAnime).toHaveBeenCalledTimes(21);
    expect(h.prisma.category.upsert).toHaveBeenCalledOnce();
    expect(h.prisma.anime.findMany).toHaveBeenCalledWith({
      where: {
        availability: 'AVAILABLE',
        sourceId: { notIn: twoPages.map((entry) => entry.id) },
      },
      select: { slug: true },
    });
    expect(h.source.getAnime).toHaveBeenCalledWith(
      'anime-gone',
      expect.any(AbortSignal),
    );
    expect(h.projection.markNotFound).toHaveBeenCalledWith('anime-gone');
    expect(h.projection.replaceSnapshot).toHaveBeenCalledWith(
      CATALOG_PASS_KEY,
      'CATALOG',
      [],
      { ttlMinutes: 24 * 60, totalRecords: 21 },
    );
    expect(Math.round(h.nextAttemptIn() / 1_000)).toBe(24 * 60 * 60);
  });

  it.each([
    ['a page fails', () => Promise.reject(new Error('offline'))],
    ['a page comes back empty', () => Promise.resolve(page([], 40))],
    ['a range is capped', () => Promise.resolve(page([listed('1')], 1_000))],
  ])(
    'removes nothing and records no pass when %s',
    async (_case, broken: () => Promise<SourceCatalog>) => {
      const h = harness((params) =>
        params.get('minYear') === '2010'
          ? broken()
          : Promise.resolve(page([listed(params.get('minYear')!)])),
      );
      await h.run();

      // The other ranges are still stored.
      expect(h.projection.upsertAnime).toHaveBeenCalled();
      expect(h.prisma.anime.findMany).not.toHaveBeenCalled();
      expect(h.source.getAnime).not.toHaveBeenCalled();
      expect(h.projection.markNotFound).not.toHaveBeenCalled();
      expect(h.projection.replaceSnapshot).not.toHaveBeenCalled();
      expect(Math.round(h.nextAttemptIn() / 1_000)).toBe(60 * 60);
    },
  );

  it('does nothing while another process holds the pass', async () => {
    const h = harness(() => Promise.resolve(page([])), false);
    await h.run();

    expect(h.source.getCatalog).not.toHaveBeenCalled();
    expect(h.prisma.homeRefreshLease.updateMany).toHaveBeenCalledOnce();
  });
});
