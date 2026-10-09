import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import {
  AnimeAv1NotFoundError,
  AnimeAv1Service,
  AnimeAv1UnavailableError,
} from '../source/animeav1.service';
import type {
  SourceAnimeDetail,
  SourceEpisode,
  SourceStatus,
} from '../source/source.types';
import { AnimeService } from './anime.service';

const sourceDetail: SourceAnimeDetail = {
  id: 'source-anime',
  slug: 'airing-show',
  title: 'Airing Show',
  synopsis: 'Synopsis',
  posterUrl: 'https://cdn.test/poster.jpg',
  backdropUrl: 'https://cdn.test/backdrop.jpg',
  category: null,
  genres: [],
  status: 'AIRING',
  startDate: new Date('2026-07-01T00:00:00.000Z'),
  mature: false,
  alternativeTitle: null,
  trailerUrl: null,
  endDate: null,
  nextEpisodeAt: null,
  episodeCount: 8,
  score: null,
  votes: null,
  episodes: [],
  relations: [],
};

const cachedEpisode: SourceEpisode = {
  id: 'episode-8',
  number: 8,
  title: 'Episode 8',
  imageUrl: 'https://cdn.test/episode.jpg',
  sourcePath: '/media/airing-show/8',
  publishedAt: new Date('2026-08-26T15:55:00.000Z'),
};

interface HarnessOptions {
  status?: SourceStatus;
  initialEpisodes?: SourceEpisode[];
  nextRefreshAt?: Date;
  nextEpisodeAt?: Date | null;
  cached?: boolean;
}

function toEpisodeRecord(episode: SourceEpisode) {
  return {
    sourceId: episode.id,
    number: episode.number,
    title: episode.title,
    imageUrl: episode.imageUrl,
    publishedAt: episode.publishedAt,
  };
}

function createHarness(options: HarnessOptions = {}) {
  const anime = {
    id: 'db-anime',
    sourceId: sourceDetail.id,
    slug: sourceDetail.slug,
    title: sourceDetail.title,
    synopsis: sourceDetail.synopsis,
    posterUrl: sourceDetail.posterUrl,
    backdropUrl: sourceDetail.backdropUrl,
    status: options.status ?? 'AIRING',
    category: null,
    startDate: sourceDetail.startDate,
    mature: false,
    availability: 'AVAILABLE',
    detailFetchedAt: new Date(Date.now() - 20 * 60_000),
    lastFetchedAt: new Date(Date.now() - 20 * 60_000),
    nextRefreshAt: options.nextRefreshAt ?? new Date(Date.now() - 60_000),
    nextEpisodeAt: options.nextEpisodeAt ?? null,
    outgoingRelations: [],
  };
  let episodes = (options.initialEpisodes ?? [cachedEpisode]).map(
    toEpisodeRecord,
  );
  const cached = options.cached ?? true;
  const prisma = {
    anime: {
      findUnique: vi.fn(() => Promise.resolve(cached ? anime : null)),
      findUniqueOrThrow: vi.fn(() => Promise.resolve(anime)),
    },
    episode: {
      findMany: vi.fn(() => Promise.resolve(episodes)),
      count: vi.fn(() => Promise.resolve(episodes.length)),
      aggregate: vi.fn(() => {
        const numbers = episodes.map((episode) => episode.number);
        return Promise.resolve({
          _min: { number: numbers.length ? Math.min(...numbers) : null },
          _max: { number: numbers.length ? Math.max(...numbers) : null },
        });
      }),
    },
  };
  const source = { getAnime: vi.fn<() => Promise<SourceAnimeDetail>>() };
  const projection = {
    upsertDetail: vi.fn((detail: SourceAnimeDetail) => {
      anime.status = detail.status;
      anime.nextRefreshAt = new Date(Date.now() + 15 * 60_000);
      anime.nextEpisodeAt = detail.nextEpisodeAt;
      for (const episode of detail.episodes) {
        if (!episodes.some((record) => record.sourceId === episode.id)) {
          episodes = [...episodes, toEpisodeRecord(episode)];
        }
      }
      return Promise.resolve(anime);
    }),
    markNotFound: vi.fn(() => Promise.resolve(undefined)),
  };
  const service = new AnimeService(
    prisma as unknown as PrismaService,
    projection as unknown as ProjectionService,
    source as unknown as AnimeAv1Service,
  );
  return { service, prisma, source };
}

describe('AnimeService episode freshness', () => {
  it('does not read cached episodes until an airing-title refresh completes', async () => {
    const { service, prisma, source } = createHarness();
    let resolveSource!: (detail: SourceAnimeDetail) => void;
    source.getAnime.mockImplementation(
      () =>
        new Promise<SourceAnimeDetail>((resolve) => {
          resolveSource = resolve;
        }),
    );

    const responsePromise = service.getEpisodes('airing-show', 1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(source.getAnime).toHaveBeenCalledTimes(1);
    expect(prisma.episode.findMany).not.toHaveBeenCalled();
    resolveSource(sourceDetail);
    const response = await responsePromise;

    expect(response.data.map((episode) => episode.number)).toEqual([8]);
    expect(prisma.episode.findMany).toHaveBeenCalledTimes(1);
  });

  it('falls back to cached episodes when AnimeAV1 is unavailable', async () => {
    const { service, source } = createHarness();
    source.getAnime.mockRejectedValue(new Error('upstream unavailable'));

    const response = await service.getEpisodes('airing-show', 1);

    expect(response.data).toHaveLength(1);
    expect(response.meta.totalRecords).toBe(1);
  });

  it('waits through an upcoming premiere and returns episode 1 instead of the cached empty list', async () => {
    const premiereEpisode: SourceEpisode = {
      id: 'episode-1',
      number: 1,
      title: 'Episode 1',
      imageUrl: 'https://cdn.test/premiere.jpg',
      sourcePath: '/media/airing-show/1',
      publishedAt: new Date('2026-08-26T18:00:00.000Z'),
    };
    const { service, source } = createHarness({
      status: 'UPCOMING',
      initialEpisodes: [],
      // The normal six-hour upcoming TTL has not elapsed, but AnimeAV1's exact
      // nextDate says the premiere is already due.
      nextRefreshAt: new Date(Date.now() + 2 * 60 * 60_000),
      nextEpisodeAt: new Date(Date.now() - 60_000),
    });
    source.getAnime.mockResolvedValue({
      ...sourceDetail,
      status: 'AIRING',
      episodeCount: 1,
      episodes: [premiereEpisode],
    });

    const response = await service.getEpisodes('airing-show', 1);

    expect(source.getAnime).toHaveBeenCalledTimes(1);
    expect(response.data.map((episode) => episode.number)).toEqual([1]);
    expect(response.meta.totalRecords).toBe(1);
  });
});

describe('AnimeService episode bounds', () => {
  const episode = (number: number): SourceEpisode => ({
    ...cachedEpisode,
    id: `episode-${number}`,
    number,
    sourcePath: `/media/airing-show/${number}`,
  });

  it('reports the bounds of every episode, not only the current page', async () => {
    const { service, prisma } = createHarness({
      status: 'FINISHED',
      nextRefreshAt: new Date(Date.now() + 60_000),
      initialEpisodes: [episode(1), episode(2), episode(12.5), episode(120)],
    });
    // A page only ever sees a slice; the aggregate covers the whole anime.
    prisma.episode.findMany.mockResolvedValueOnce([]);

    const response = await service.getEpisodes('airing-show', 3);

    expect(response.data).toEqual([]);
    expect(response.meta).toMatchObject({ firstNumber: 1, lastNumber: 120 });
    expect(prisma.episode.aggregate).toHaveBeenCalledWith({
      where: { animeId: 'db-anime' },
      _min: { number: true },
      _max: { number: true },
    });
  });

  it('keeps a movie numbered 0 instead of treating it as missing', async () => {
    const { service } = createHarness({
      status: 'FINISHED',
      nextRefreshAt: new Date(Date.now() + 60_000),
      initialEpisodes: [episode(0)],
    });

    const response = await service.getEpisodes('airing-show', 1);

    expect(response.meta).toMatchObject({
      totalRecords: 1,
      firstNumber: 0,
      lastNumber: 0,
    });
  });

  it('returns null bounds for an anime without episodes', async () => {
    const { service } = createHarness({
      status: 'FINISHED',
      nextRefreshAt: new Date(Date.now() + 60_000),
      initialEpisodes: [],
    });

    const response = await service.getEpisodes('airing-show', 1);

    expect(response.meta).toMatchObject({
      totalRecords: 0,
      firstNumber: null,
      lastNumber: null,
    });
  });
});

describe('AnimeService unknown slugs', () => {
  it('answers 404 when the source says the anime does not exist', async () => {
    const { service, source } = createHarness({ cached: false });
    source.getAnime.mockRejectedValue(new AnimeAv1NotFoundError('/media/x'));

    await expect(service.getAnime('zz-no-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getEpisodes('zz-no-existe', 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('keeps 503 for a real upstream outage on an uncached slug', async () => {
    const { service, source } = createHarness({ cached: false });
    source.getAnime.mockRejectedValue(new AnimeAv1UnavailableError('down'));

    await expect(service.getAnime('one-piece')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
