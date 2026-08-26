import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
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
    status: options.status ?? ('AIRING' as SourceStatus),
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
  const prisma = {
    anime: {
      findUnique: vi.fn(() => Promise.resolve(anime)),
      findUniqueOrThrow: vi.fn(() => Promise.resolve(anime)),
    },
    episode: {
      findMany: vi.fn(() => Promise.resolve(episodes)),
      count: vi.fn(() => Promise.resolve(episodes.length)),
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
