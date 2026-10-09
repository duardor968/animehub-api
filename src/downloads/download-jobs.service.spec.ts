import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import { AnimeService } from '../anime/anime.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DownloadJobItemStatus,
  DownloadJobStatus,
} from '../generated/prisma/client';
import {
  DownloadJobsService,
  hashCapabilityToken,
} from './download-jobs.service';
import { DownloadResolverService } from './download-resolver.service';
import {
  CreateDownloadJobDto,
  DownloadScopeDto,
  ProviderDto,
  RequestedAudioDto,
} from './download.dto';

function harness(numbers: number[]) {
  const episodes = numbers.map((number) => ({ id: `ep-${number}`, number }));
  const prisma = {
    episode: {
      findMany: vi.fn(
        ({
          where,
        }: {
          where: { number?: { in?: number[]; gte?: number; lte?: number } };
        }) => {
          const filter = where.number;
          return Promise.resolve(
            episodes.filter(
              ({ number }) =>
                !filter ||
                (filter.in
                  ? filter.in.includes(number)
                  : number >= filter.gte! && number <= filter.lte!),
            ),
          );
        },
      ),
    },
    downloadJob: {
      create: vi.fn(() => Promise.resolve({ id: 'job-1' })),
      // The in-process worker (jobs disabled) finds nothing to process.
      findUnique: vi.fn(() => Promise.resolve(null)),
    },
  };
  const animeService = {
    ensureAnime: vi.fn(() =>
      Promise.resolve({ id: 'anime-1', title: 'One Piece' }),
    ),
  };
  const service = new DownloadJobsService(
    new ConfigService({ JOBS_ENABLED: 'false' }),
    prisma as unknown as PrismaService,
    animeService as unknown as AnimeService,
    {} as DownloadResolverService,
  );
  const create = (input: Partial<CreateDownloadJobDto>) =>
    service.create('one-piece', {
      audio: RequestedAudioDto.SUB,
      providers: [ProviderDto.MEGA],
      ...input,
    } as CreateDownloadJobDto);
  const createdEpisodeIds = () =>
    (
      prisma.downloadJob.create.mock.calls[0] as unknown as [
        {
          data: {
            totalItems: number;
            items: { create: Array<{ episodeId: string }> };
          };
        },
      ]
    )[0].data;
  return { prisma, create, createdEpisodeIds };
}

describe('DownloadJobsService.create', () => {
  it('queues exactly the requested episodes and reports the missing ones', async () => {
    const h = harness([0, 1, 2, 3, 12.5, 50, 51]);

    const receipt = await h.create({
      scope: DownloadScopeDto.EPISODES,
      episodeNumbers: [51, 2, 12.5, 999, 3],
    });

    const data = h.createdEpisodeIds();
    expect(data.totalItems).toBe(4);
    expect(data.items.create.map((item) => item.episodeId)).toEqual([
      'ep-2',
      'ep-3',
      'ep-12.5',
      'ep-51',
    ]);
    expect(receipt.data.missingEpisodeNumbers).toEqual([999]);
    expect(h.prisma.episode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { animeId: 'anime-1', number: { in: [2, 3, 12.5, 51, 999] } },
      }),
    );
  });

  it('rejects an EPISODES selection that matches nothing', async () => {
    const h = harness([1, 2]);

    await expect(
      h.create({ scope: DownloadScopeDto.EPISODES, episodeNumbers: [7, 8] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.downloadJob.create).not.toHaveBeenCalled();
  });

  it('bounds RANGE by both ends and never widens it to the whole series', async () => {
    const h = harness([1, 2, 3, 4, 5, 6]);

    const receipt = await h.create({
      scope: DownloadScopeDto.RANGE,
      from: 2,
      to: 4,
    });

    expect(h.createdEpisodeIds().totalItems).toBe(3);
    expect(receipt.data.missingEpisodeNumbers).toEqual([]);
  });

  it('keeps ALL as the whole series, ignoring bounds older clients send', async () => {
    const h = harness([0, 1, 2]);

    await h.create({ scope: DownloadScopeDto.ALL, from: 1, to: 1 });

    expect(h.createdEpisodeIds().totalItems).toBe(3);
  });
});

type JobRow = {
  id: string;
  animeId: string;
  accessTokenHash: string;
  status: DownloadJobStatus;
  requestedAudio: RequestedAudioDto;
  providers: ProviderDto[];
  packageName: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  expiresAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};
type ItemRow = {
  id: string;
  jobId: string;
  status: DownloadJobItemStatus;
  episodeNumber: number;
  attempts: number;
  resolvedAudio: string | null;
  links: unknown;
  errorCode: string | null;
};
type Where = Record<string, unknown>;

function matches(row: object, where: Where) {
  return Object.entries(where).every(([key, condition]) => {
    const value = (row as Record<string, unknown>)[key];
    if (condition && typeof condition === 'object' && 'in' in condition) {
      return (condition.in as unknown[]).includes(value);
    }
    return value === condition;
  });
}

function apply(row: object, data: Record<string, unknown>) {
  const target = row as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    target[key] =
      value && typeof value === 'object' && 'increment' in value
        ? (target[key] as number) + (value.increment as number)
        : value;
  }
}

/** A deferred resolution per episode, so a test can interleave cancel(). */
function deferredResolver() {
  const pending = new Map<number, (outcome: 'ok' | 'error') => void>();
  const started = new Map<number, Promise<void>>();
  const markStarted = new Map<number, () => void>();
  const startedFor = (episode: number) => {
    if (!started.has(episode)) {
      started.set(
        episode,
        new Promise((resolve) => markStarted.set(episode, resolve)),
      );
    }
    return started.get(episode)!;
  };
  const resolver = {
    resolveEpisode: vi.fn(
      (_animeId: string, _slug: string, episode: number) =>
        new Promise((resolve, reject) => {
          pending.set(episode, (outcome) =>
            outcome === 'ok'
              ? resolve({
                  audio: RequestedAudioDto.SUB,
                  links: [
                    { provider: ProviderDto.MEGA, url: `mega/${episode}` },
                  ],
                  errorCode: null,
                })
              : reject(new Error('source down')),
          );
          void startedFor(episode);
          markStarted.get(episode)!();
        }),
    ),
  };
  return {
    resolver,
    started: startedFor,
    finish: (episode: number, outcome: 'ok' | 'error' = 'ok') =>
      pending.get(episode)!(outcome),
  };
}

function jobHarness(
  numbers: number[],
  status: DownloadJobStatus = DownloadJobStatus.QUEUED,
) {
  const token = 'capability';
  const job: JobRow = {
    id: 'job-1',
    animeId: 'anime-1',
    accessTokenHash: hashCapabilityToken(token),
    status,
    requestedAudio: RequestedAudioDto.SUB,
    providers: [ProviderDto.MEGA],
    packageName: 'One Piece',
    totalItems: numbers.length,
    completedItems: 0,
    failedItems: 0,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    startedAt: null,
    completedAt: null,
  };
  const items: ItemRow[] = numbers.map((number) => ({
    id: `item-${number}`,
    jobId: job.id,
    status: DownloadJobItemStatus.PENDING,
    episodeNumber: number,
    attempts: 0,
    resolvedAudio: null,
    links: null,
    errorCode: null,
  }));
  const snapshot = () => ({
    ...job,
    anime: { slug: 'one-piece' },
    items: items.map((item) => ({
      ...item,
      episode: { number: item.episodeNumber },
    })),
  });
  const prisma = {
    downloadJob: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === job.id ? snapshot() : null),
      ),
      updateMany: vi.fn(
        ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
          const hit = matches(job, where);
          if (hit) apply(job, data);
          return Promise.resolve({ count: hit ? 1 : 0 });
        },
      ),
    },
    downloadJobItem: {
      updateMany: vi.fn(
        ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
          const hits = items.filter((item) => matches(item, where));
          for (const item of hits) apply(item, data);
          return Promise.resolve({ count: hits.length });
        },
      ),
      count: vi.fn(({ where }: { where: Where }) =>
        Promise.resolve(items.filter((item) => matches(item, where)).length),
      ),
    },
    $transaction: vi.fn((work: (transaction: unknown) => Promise<unknown>) =>
      work(prisma),
    ),
  };
  const sources = deferredResolver();
  const service = new DownloadJobsService(
    new ConfigService({ JOBS_ENABLED: 'false' }),
    prisma as unknown as PrismaService,
    {} as AnimeService,
    sources.resolver as unknown as DownloadResolverService,
  );
  const process = () =>
    (service as unknown as { process(id: string): Promise<void> }).process(
      job.id,
    );
  const itemStatus = (number: number) =>
    items.find((item) => item.episodeNumber === number)!.status;
  return { service, prisma, sources, job, items, token, process, itemStatus };
}

describe('DownloadJobsService job state races', () => {
  it('reports a job that finished first instead of cancelling it', async () => {
    const h = jobHarness([1, 2]);
    const run = h.process();
    await h.sources.started(1);
    await h.sources.started(2);
    h.sources.finish(1);
    h.sources.finish(2);
    await run;
    const completedAt = h.job.completedAt;

    const response = await h.service.cancel(h.job.id, h.token);

    expect(response.data.status).toBe(DownloadJobStatus.COMPLETED);
    expect(response.data.completedItems).toBe(2);
    expect(response.data.episodes.map((episode) => episode.links)).toEqual([
      [{ provider: ProviderDto.MEGA, url: 'mega/1' }],
      [{ provider: ProviderDto.MEGA, url: 'mega/2' }],
    ]);
    expect(h.job.status).toBe(DownloadJobStatus.COMPLETED);
    expect(h.job.completedAt).toBe(completedAt);
  });

  it.each([DownloadJobStatus.PARTIAL, DownloadJobStatus.FAILED])(
    'leaves a %s job untouched on cancel',
    async (status) => {
      const h = jobHarness([1], status);
      h.items[0].status = DownloadJobItemStatus.FAILED;

      const response = await h.service.cancel(h.job.id, h.token);

      expect(response.data.status).toBe(status);
      expect(h.itemStatus(1)).toBe(DownloadJobItemStatus.FAILED);
      expect(h.prisma.downloadJobItem.updateMany).not.toHaveBeenCalled();
    },
  );

  it('keeps CANCELLED when the worker finishes after a cancel', async () => {
    const h = jobHarness([1, 2, 3]);
    const run = h.process();
    await Promise.all([1, 2, 3].map((number) => h.sources.started(number)));
    h.sources.finish(1);
    await vi.waitFor(() =>
      expect(h.itemStatus(1)).toBe(DownloadJobItemStatus.COMPLETED),
    );

    const response = await h.service.cancel(h.job.id, h.token);
    const cancelledAt = h.job.completedAt;
    h.sources.finish(2);
    h.sources.finish(3, 'error');
    await run;

    expect(response.data.status).toBe(DownloadJobStatus.CANCELLED);
    expect(h.job.status).toBe(DownloadJobStatus.CANCELLED);
    expect(h.job.completedAt).toBe(cancelledAt);
    // Resolved before the cancel: still available. In flight: discarded.
    expect(h.itemStatus(1)).toBe(DownloadJobItemStatus.COMPLETED);
    expect(h.itemStatus(2)).toBe(DownloadJobItemStatus.CANCELLED);
    expect(h.itemStatus(3)).toBe(DownloadJobItemStatus.CANCELLED);
    expect(h.job).toMatchObject({ completedItems: 1, failedItems: 0 });
    const after = await h.service.get(h.job.id, h.token);
    expect(after.data).toMatchObject({
      status: DownloadJobStatus.CANCELLED,
      completedItems: 1,
      failedItems: 0,
    });
  });

  it('never claims an item cancelled before the worker reached it', async () => {
    const h = jobHarness(Array.from({ length: 10 }, (_, index) => index + 1));
    const run = h.process();
    // pLimit(8): episodes 9 and 10 are still PENDING when the cancel lands.
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => h.sources.started(index + 1)),
    );
    expect(h.itemStatus(9)).toBe(DownloadJobItemStatus.PENDING);

    await h.service.cancel(h.job.id, h.token);
    for (let number = 1; number <= 8; number += 1) h.sources.finish(number);
    await run;

    expect(h.sources.resolver.resolveEpisode).toHaveBeenCalledTimes(8);
    expect(h.items.map((item) => item.status)).toEqual(
      Array(10).fill(DownloadJobItemStatus.CANCELLED),
    );
    expect(h.job.status).toBe(DownloadJobStatus.CANCELLED);
  });

  it('stops when the cancel lands between reading the job and starting it', async () => {
    const h = jobHarness([1, 2]);
    h.prisma.downloadJob.findUnique.mockImplementationOnce(async () => {
      const stale = {
        ...h.job,
        anime: { slug: 'one-piece' },
        items: h.items.map((item) => ({
          ...item,
          episode: { number: item.episodeNumber },
        })),
      };
      await h.service.cancel(h.job.id, h.token);
      return stale;
    });

    await h.process();

    expect(h.job.status).toBe(DownloadJobStatus.CANCELLED);
    expect(h.job.startedAt).toBeNull();
    expect(h.sources.resolver.resolveEpisode).not.toHaveBeenCalled();
  });

  it('retries only a finished job with failures', async () => {
    const running = jobHarness([1], DownloadJobStatus.RUNNING);
    running.items[0].status = DownloadJobItemStatus.FAILED;
    const cancelled = jobHarness([1], DownloadJobStatus.CANCELLED);
    cancelled.items[0].status = DownloadJobItemStatus.FAILED;
    const partial = jobHarness([1, 2], DownloadJobStatus.PARTIAL);
    partial.items[0].status = DownloadJobItemStatus.COMPLETED;
    partial.items[1].status = DownloadJobItemStatus.FAILED;

    for (const h of [running, cancelled]) {
      await expect(h.service.retry(h.job.id, h.token)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(h.itemStatus(1)).toBe(DownloadJobItemStatus.FAILED);
    }
    await partial.service.retry(partial.job.id, partial.token);
    await partial.sources.started(2);

    expect(partial.itemStatus(1)).toBe(DownloadJobItemStatus.COMPLETED);
    expect(partial.itemStatus(2)).toBe(DownloadJobItemStatus.RUNNING);
    expect(partial.job.status).toBe(DownloadJobStatus.RUNNING);
  });
});
