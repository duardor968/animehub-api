import { vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { ProjectionService } from './projection.service';
import { RelationDiscoveryScheduler } from './relation-discovery.scheduler';

function harness() {
  const prisma = {
    anime: { findMany: vi.fn().mockResolvedValue([{ slug: 'new' }]) },
  };
  const detail = {
    slug: 'new',
    relations: [{ kind: 'PREQUEL', anime: { slug: 'old' } }],
  };
  const source = { getAnime: vi.fn().mockResolvedValue(detail) };
  const projection = { upsertDetail: vi.fn().mockResolvedValue({}) };
  const scheduler = new RelationDiscoveryScheduler(
    new ConfigService({ JOBS_ENABLED: 'false' }),
    prisma as unknown as PrismaService,
    source as unknown as AnimeAv1Service,
    projection as unknown as ProjectionService,
  );
  return { prisma, source, projection, scheduler, detail };
}

describe('observed relation discovery', () => {
  it('persists new to finished old edges without fetching old or requiring a visit', async () => {
    const h = harness();
    await h.scheduler.refreshObserved();
    expect(h.source.getAnime).toHaveBeenCalledTimes(1);
    expect(h.source.getAnime).toHaveBeenCalledWith(
      'new',
      expect.any(AbortSignal),
    );
    expect(h.projection.upsertDetail).toHaveBeenCalledWith(h.detail);
    expect(h.prisma.anime.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 8,
        where: expect.objectContaining({
          snapshotItems: expect.any(Object) as unknown,
          OR: [
            { detailFetchedAt: null },
            { detailFetchedAt: { lte: expect.any(Date) as unknown } },
            { nextRefreshAt: { lte: expect.any(Date) as unknown } },
          ],
        }) as unknown,
      }),
    );
  });

  it('backs off failed candidates and continues independent titles without inventing edges', async () => {
    const h = harness();
    h.prisma.anime.findMany.mockResolvedValue([
      { slug: 'broken' },
      { slug: 'unrelated' },
    ]);
    h.source.getAnime
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ slug: 'unrelated', relations: [] });
    await h.scheduler.refreshObserved();
    expect(h.projection.upsertDetail).toHaveBeenCalledTimes(1);
    expect(h.projection.upsertDetail).toHaveBeenCalledWith({
      slug: 'unrelated',
      relations: [],
    });
    h.prisma.anime.findMany.mockResolvedValue([]);
    await h.scheduler.refreshObserved();
    expect(h.prisma.anime.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          slug: { notIn: ['broken'] },
        }) as unknown,
      }),
    );
  });

  it('honors disabled jobs and cancels active source work on shutdown', async () => {
    const h = harness();
    h.scheduler.onModuleInit();
    expect(h.prisma.anime.findMany).not.toHaveBeenCalled();
    h.source.getAnime.mockImplementation(
      (_slug: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const pending = h.scheduler.refreshObserved();
    await vi.waitFor(() => expect(h.source.getAnime).toHaveBeenCalled());
    await h.scheduler.onModuleDestroy();
    await pending;
    expect(h.projection.upsertDetail).not.toHaveBeenCalled();
  });
});
