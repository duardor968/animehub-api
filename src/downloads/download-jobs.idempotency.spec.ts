import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import { AnimeService } from '../anime/anime.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DownloadJobsController } from './download-jobs.controller';
import {
  DownloadJobsService,
  hashCapabilityToken,
  requestFingerprint,
} from './download-jobs.service';
import { DownloadResolverService } from './download-resolver.service';
import {
  CreateDownloadJobDto,
  DownloadScopeDto,
  ProviderDto,
  RequestedAudioDto,
} from './download.dto';

type StoredJob = {
  id: string;
  accessTokenHash: string;
  idempotencyKeyHash: string | null;
  requestFingerprint: string | null;
  replayTokenHashes: string[];
  expiresAt: Date;
  episodeIds: string[];
};

const KEY = '3f1c9a52-7d4e-4b8a-9c61-2e5f0d7a8b14';

function harness(numbers = [1, 2, 3]) {
  const episodes = numbers.map((number) => ({ id: `ep-${number}`, number }));
  const jobs: StoredJob[] = [];
  const view = (job: StoredJob) => ({
    ...job,
    status: 'QUEUED',
    packageName: 'One Piece',
    totalItems: job.episodeIds.length,
    requestedAudio: RequestedAudioDto.SUB,
    items: job.episodeIds.map((episodeId) => ({
      status: 'PENDING',
      episode: episodes.find((episode) => episode.id === episodeId)!,
    })),
  });
  const prisma = {
    episode: {
      findMany: vi.fn(({ where }: { where: { number?: { in?: number[] } } }) =>
        Promise.resolve(
          episodes.filter(
            ({ number }) =>
              !where.number?.in || where.number.in.includes(number),
          ),
        ),
      ),
    },
    downloadJob: {
      create: vi.fn(
        ({
          data,
        }: {
          data: Omit<StoredJob, 'id' | 'replayTokenHashes' | 'episodeIds'> & {
            items: { create: Array<{ episodeId: string }> };
          };
        }) => {
          if (
            data.idempotencyKeyHash &&
            jobs.some(
              (job) => job.idempotencyKeyHash === data.idempotencyKeyHash,
            )
          ) {
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError('Unique constraint', {
                code: 'P2002',
                clientVersion: 'test',
              }),
            );
          }
          const job: StoredJob = {
            id: `job-${jobs.length + 1}`,
            accessTokenHash: data.accessTokenHash,
            idempotencyKeyHash: data.idempotencyKeyHash ?? null,
            requestFingerprint: data.requestFingerprint ?? null,
            replayTokenHashes: [],
            expiresAt: data.expiresAt,
            episodeIds: data.items.create.map((item) => item.episodeId),
          };
          jobs.push(job);
          return Promise.resolve({ id: job.id });
        },
      ),
      findFirst: vi.fn(
        ({ where }: { where: { idempotencyKeyHash: string } }) => {
          const job = jobs.find(
            (candidate) =>
              candidate.idempotencyKeyHash === where.idempotencyKeyHash,
          );
          return Promise.resolve(job ? view(job) : null);
        },
      ),
      findUnique: vi.fn(
        ({ where, include }: { where: { id: string }; include: object }) => {
          // The in-process worker (jobs disabled) finds nothing to process.
          if ('anime' in include) return Promise.resolve(null);
          const job = jobs.find((candidate) => candidate.id === where.id);
          return Promise.resolve(job ? view(job) : null);
        },
      ),
      update: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { replayTokenHashes: { push: string } };
        }) => {
          jobs
            .find((job) => job.id === where.id)!
            .replayTokenHashes.push(data.replayTokenHashes.push);
          return Promise.resolve({});
        },
      ),
      updateMany: vi.fn(
        ({
          where,
        }: {
          where: { id: string; idempotencyKeyHash: string };
          data: { idempotencyKeyHash: null };
        }) => {
          const job = jobs.find(
            (candidate) =>
              candidate.id === where.id &&
              candidate.idempotencyKeyHash === where.idempotencyKeyHash,
          );
          if (job) job.idempotencyKeyHash = null;
          return Promise.resolve({ count: job ? 1 : 0 });
        },
      ),
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
  const create = (input: Partial<CreateDownloadJobDto>, key?: string) =>
    service.create(
      'one-piece',
      {
        scope: DownloadScopeDto.EPISODES,
        episodeNumbers: [3, 1, 9],
        audio: RequestedAudioDto.SUB,
        providers: [ProviderDto.MEGA],
        ...input,
      },
      key,
    );
  return { service, prisma, animeService, jobs, create };
}

describe('DownloadJobsService idempotent creation', () => {
  it('returns the same job with a new working token when the key is replayed', async () => {
    const h = harness();

    const first = await h.create({}, KEY);
    const replay = await h.create({ episodeNumbers: [9, 1, 3] }, KEY);

    expect(h.jobs).toHaveLength(1);
    expect(h.prisma.downloadJob.create).toHaveBeenCalledTimes(1);
    expect(h.animeService.ensureAnime).toHaveBeenCalledTimes(1);
    expect(replay.data).toMatchObject({
      jobId: first.data.jobId,
      expiresAt: first.data.expiresAt,
      missingEpisodeNumbers: [9],
    });
    expect(replay.data.accessToken).not.toBe(first.data.accessToken);
    expect(h.jobs[0].idempotencyKeyHash).not.toContain(KEY);
    for (const token of [first.data.accessToken, replay.data.accessToken]) {
      const job = await h.service.get(first.data.jobId, token);
      expect(job.data.id).toBe(first.data.jobId);
    }
  });

  it('creates separate jobs without a key or with different keys', async () => {
    const h = harness();

    await h.create({});
    await h.create({});
    await h.create({}, KEY);
    await h.create({}, `${KEY}-other`);

    expect(h.jobs.map((job) => job.id)).toEqual([
      'job-1',
      'job-2',
      'job-3',
      'job-4',
    ]);
  });

  it('rejects a key reused with a different request', async () => {
    const h = harness();
    await h.create({}, KEY);

    await expect(
      h.create({ audio: RequestedAudioDto.DUB }, KEY),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      h.create({ scope: DownloadScopeDto.ALL, episodeNumbers: undefined }, KEY),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.jobs).toHaveLength(1);
  });

  it('replays the job of a concurrent request that won the insert', async () => {
    const h = harness();
    // Both requests passed the replay lookup before either job existed.
    h.prisma.downloadJob.findFirst.mockResolvedValueOnce(null);
    h.prisma.downloadJob.findFirst.mockResolvedValueOnce(null);

    const [first, second] = await Promise.all([
      h.create({}, KEY),
      h.create({}, KEY),
    ]);

    expect(h.jobs).toHaveLength(1);
    expect(second.data.jobId).toBe(first.data.jobId);
    expect(h.jobs[0].replayTokenHashes).toEqual([
      hashCapabilityToken(second.data.accessToken),
    ]);
  });

  it('starts a new job once the keyed job has expired', async () => {
    const h = harness();
    const first = await h.create({}, KEY);
    h.jobs[0].expiresAt = new Date(Date.now() - 1);

    const second = await h.create({}, KEY);

    expect(second.data.jobId).not.toBe(first.data.jobId);
    expect(h.jobs.map((job) => job.idempotencyKeyHash !== null)).toEqual([
      false,
      true,
    ]);
  });

  it('bounds how many tokens one key can mint', async () => {
    const h = harness();
    await h.create({}, KEY);
    for (let replay = 0; replay < 10; replay += 1) await h.create({}, KEY);

    await expect(h.create({}, KEY)).rejects.toBeInstanceOf(ConflictException);
  });

  it('fingerprints what the job uses, not how the request spells it', () => {
    const base = {
      audio: RequestedAudioDto.SUB,
      providers: [ProviderDto.MEGA],
    };
    const all = (extra: object) =>
      requestFingerprint({
        ...base,
        scope: DownloadScopeDto.ALL,
        ...extra,
      });
    const episodes = (episodeNumbers: number[]) =>
      requestFingerprint({
        ...base,
        scope: DownloadScopeDto.EPISODES,
        episodeNumbers,
      });
    const range = (from: number, to: number) =>
      requestFingerprint({
        ...base,
        scope: DownloadScopeDto.RANGE,
        from,
        to,
      });

    expect(all({ from: 1, to: 2 })).toBe(all({}));
    expect(episodes([2, 1, -0])).toBe(episodes([0, 1, 2]));
    expect(range(1, 2)).not.toBe(range(1, 3));
    expect(episodes([1, 2])).not.toBe(range(1, 2));
  });
});

describe('DownloadJobsController Idempotency-Key header', () => {
  const body = {
    scope: DownloadScopeDto.ALL,
    audio: RequestedAudioDto.SUB,
    providers: [ProviderDto.MEGA],
  } as CreateDownloadJobDto;

  it.each([
    [undefined, undefined],
    [KEY, KEY],
    [`  "${KEY}" `, KEY],
  ])('passes %j to the service as %j', async (header, expected) => {
    const jobs = { create: vi.fn(() => Promise.resolve({})) };
    const controller = new DownloadJobsController(
      jobs as unknown as DownloadJobsService,
    );

    await controller.create('one-piece', body, header);

    expect(jobs.create).toHaveBeenCalledWith('one-piece', body, expected);
  });

  it.each(['', 'short-key', 'x'.repeat(129), `${KEY}, ${KEY}`, `${KEY} é`])(
    'rejects %j with 400',
    (header) => {
      const jobs = { create: vi.fn() };
      const controller = new DownloadJobsController(
        jobs as unknown as DownloadJobsService,
      );

      expect(() => controller.create('one-piece', body, header)).toThrow(
        BadRequestException,
      );
      expect(jobs.create).not.toHaveBeenCalled();
    },
  );
});
