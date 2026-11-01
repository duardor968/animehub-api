import { vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
} from '../source/animeav1.service';
import { ProjectionService } from './projection.service';
import { DetailRefreshScheduler } from './detail-refresh.scheduler';

// The pauses resolve at once; each is recorded.
const pause = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('node:timers/promises', () => ({ setTimeout: pause }));

function harness(batches: string[][]) {
  const findMany = vi.fn().mockResolvedValue([]);
  for (const batch of batches)
    findMany.mockResolvedValueOnce(batch.map((slug) => ({ slug })));
  const prisma = { anime: { findMany } };
  const source = {
    getAnime: vi.fn((slug: string) => Promise.resolve({ slug, relations: [] })),
  };
  const projection = {
    upsertDetail: vi.fn().mockResolvedValue({}),
    markNotFound: vi.fn().mockResolvedValue(undefined),
  };
  const scheduler = new DetailRefreshScheduler(
    new ConfigService({ JOBS_ENABLED: 'false' }),
    prisma as unknown as PrismaService,
    source as unknown as AnimeAv1Service,
    projection as unknown as ProjectionService,
  );
  return { prisma, source, projection, scheduler };
}

describe('detail refresh over the whole catalog', () => {
  beforeEach(() => pause.mockClear());

  it('picks the never fetched first, then those due, one at a time with a pause', async () => {
    const h = harness([['new', 'other'], ['due']]);
    await h.scheduler.refreshDue();

    expect(h.source.getAnime.mock.calls.map(([slug]) => slug)).toEqual([
      'new',
      'other',
      'due',
    ]);
    expect(h.projection.upsertDetail).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledWith(1_000, undefined, expect.anything());
    expect(h.prisma.anime.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          slug: { notIn: [] },
          availability: 'AVAILABLE',
          OR: [
            { detailFetchedAt: null },
            {
              status: { not: 'AIRING' },
              nextRefreshAt: { lte: expect.any(Date) as unknown },
            },
            {
              status: 'AIRING',
              detailFetchedAt: { lte: expect.any(Date) as unknown },
            },
          ],
        },
        orderBy: [
          { detailFetchedAt: { sort: 'asc', nulls: 'first' } },
          { id: 'asc' },
        ],
      }),
    );
  });

  it('counts a not-found answer, backs off failures and goes on with the rest', async () => {
    const h = harness([['gone', 'broken', 'fine']]);
    h.source.getAnime
      .mockRejectedValueOnce(new AnimeAv1NotFoundError('/media/gone'))
      .mockRejectedValueOnce(new Error('offline'));
    await h.scheduler.refreshDue();

    expect(h.projection.markNotFound).toHaveBeenCalledWith('gone');
    expect(h.projection.upsertDetail).toHaveBeenCalledTimes(1);
    expect(h.prisma.anime.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          slug: { notIn: ['gone', 'broken'] },
        }) as unknown,
      }),
    );
  });

  it('honors disabled jobs and cancels active source work on shutdown', async () => {
    const h = harness([['new']]);
    h.scheduler.onModuleInit();
    expect(h.prisma.anime.findMany).not.toHaveBeenCalled();
    h.source.getAnime.mockImplementation(
      (_slug: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const pending = h.scheduler.refreshDue();
    await vi.waitFor(() => expect(h.source.getAnime).toHaveBeenCalled());
    await h.scheduler.onModuleDestroy();
    await pending;
    expect(h.projection.upsertDetail).not.toHaveBeenCalled();
  });
});
