import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import { AnimeService } from '../anime/anime.service';
import { PrismaService } from '../prisma/prisma.service';
import { DownloadJobsService } from './download-jobs.service';
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
