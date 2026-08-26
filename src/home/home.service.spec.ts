import { vi } from 'vitest';
import { SnapshotKind } from '../generated/prisma/enums';
import { AnimeService } from '../anime/anime.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import type {
  SourceAnimeSummary,
  SourceEpisode,
  SourceHome,
} from '../source/source.types';
import { HOME_REQUEST_REFRESH_TIMEOUT_MS, HomeService } from './home.service';

const sourceAnime: SourceAnimeSummary = {
  id: 'source-anime',
  slug: 'airing-show',
  title: 'Airing Show',
  synopsis: 'Synopsis',
  posterUrl: 'https://cdn.test/poster.jpg',
  backdropUrl: 'https://cdn.test/backdrop.jpg',
  category: { id: 'tv', name: 'TV Anime', slug: 'tv-anime' },
  genres: [],
  status: 'AIRING',
  startDate: new Date('2026-07-01T00:00:00.000Z'),
  mature: false,
};

const sourceEpisode: SourceEpisode = {
  id: 'source-episode',
  number: 8,
  title: 'Episode 8',
  imageUrl: 'https://cdn.test/episode.jpg',
  sourcePath: '/media/airing-show/8',
  publishedAt: new Date('2026-08-26T15:55:00.000Z'),
};

const staleEpisode: SourceEpisode = {
  ...sourceEpisode,
  id: 'source-episode-7',
  number: 7,
  title: 'Episode 7',
  sourcePath: '/media/airing-show/7',
  publishedAt: new Date('2026-08-19T15:55:00.000Z'),
};

const sourceHome: SourceHome = {
  featured: [sourceAnime],
  recentEpisodes: [{ anime: sourceAnime, episode: sourceEpisode }],
  recentAnime: [sourceAnime],
};

function animeRecord() {
  return {
    id: 'db-anime',
    sourceId: sourceAnime.id,
    slug: sourceAnime.slug,
    title: sourceAnime.title,
    synopsis: sourceAnime.synopsis,
    posterUrl: sourceAnime.posterUrl,
    backdropUrl: sourceAnime.backdropUrl,
    status: sourceAnime.status,
    category: {
      sourceId: 'tv',
      name: 'TV Anime',
      slug: 'tv-anime',
    },
    startDate: sourceAnime.startDate,
    mature: false,
    genres: [],
    episodeCount: null,
    trailerUrl: null,
  };
}

function episodeRecord(episode: SourceEpisode = sourceEpisode) {
  return {
    id: `db-${episode.id}`,
    sourceId: episode.id,
    number: episode.number,
    title: episode.title,
    imageUrl: episode.imageUrl,
    publishedAt: episode.publishedAt,
  };
}

function staleSnapshots() {
  const fetchedAt = new Date(Date.now() - 20 * 60_000);
  const nextRefreshAt = new Date(Date.now() - 60_000);
  const anime = animeRecord();
  return [
    {
      id: 'featured',
      kind: SnapshotKind.HOME_FEATURED,
      fetchedAt,
      nextRefreshAt,
      items: [{ anime, episode: null }],
    },
    {
      id: 'episodes',
      kind: SnapshotKind.HOME_RECENT_EPISODES,
      fetchedAt,
      nextRefreshAt,
      items: [{ anime, episode: episodeRecord(staleEpisode) }],
    },
    {
      id: 'anime',
      kind: SnapshotKind.HOME_RECENT_ANIME,
      fetchedAt,
      nextRefreshAt,
      items: [{ anime, episode: null }],
    },
  ];
}

function createHarness() {
  const snapshots = staleSnapshots();
  let projectedEpisode = staleEpisode;
  const prisma = {
    snapshot: { findMany: vi.fn(() => Promise.resolve(snapshots)) },
    anime: {
      update: vi.fn(() => Promise.resolve({ id: 'db-anime' })),
    },
  };
  const projection = {
    upsertAnime: vi.fn(() => Promise.resolve({ id: 'db-anime' })),
    upsertEpisode: vi.fn((_animeId: string, episode: SourceEpisode) => {
      projectedEpisode = episode;
      return Promise.resolve({ id: `db-${episode.id}` });
    }),
    replaceSnapshot: vi.fn(
      (
        _key: string,
        kind: SnapshotKind,
        _entries: unknown[],
        options: { ttlMinutes: number; fetchedAt?: Date },
      ) => {
        const snapshot = snapshots.find((entry) => entry.kind === kind);
        const fetchedAt = options.fetchedAt ?? new Date();
        if (snapshot) {
          snapshot.fetchedAt = fetchedAt;
          snapshot.nextRefreshAt = new Date(
            fetchedAt.getTime() + options.ttlMinutes * 60_000,
          );
          if (kind === SnapshotKind.HOME_RECENT_EPISODES) {
            snapshot.items = [
              {
                anime: animeRecord(),
                episode: episodeRecord(projectedEpisode),
              },
            ];
          }
        }
        return Promise.resolve({ id: snapshot?.id ?? 'snapshot' });
      },
    ),
  };
  const source = { getHome: vi.fn<() => Promise<SourceHome>>() };
  const anime = {
    getAnime: vi.fn(() => Promise.resolve({ data: {}, meta: {} })),
  };
  const service = new HomeService(
    prisma as unknown as PrismaService,
    projection as unknown as ProjectionService,
    source as unknown as AnimeAv1Service,
    anime as unknown as AnimeService,
  );
  return { service, source, projection, snapshots };
}

describe('HomeService freshness', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for one single-flight refresh and gives concurrent first visitors fresh data', async () => {
    const { service, source, projection } = createHarness();
    let resolveSource!: (home: SourceHome) => void;
    source.getHome.mockImplementation(
      () =>
        new Promise<SourceHome>((resolve) => {
          resolveSource = resolve;
        }),
    );

    const first = service.getHome();
    const second = service.getHome();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(source.getHome).toHaveBeenCalledTimes(1);
    resolveSource(sourceHome);
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse.meta.stale).toBe(false);
    expect(secondResponse.meta.stale).toBe(false);
    expect(firstResponse.data.recentEpisodes[0]?.episode.number).toBe(8);
    expect(secondResponse.data.recentEpisodes[0]?.episode.number).toBe(8);
    expect(projection.replaceSnapshot).toHaveBeenCalledTimes(3);
  });

  it('serves the last good snapshot when AnimeAV1 fails', async () => {
    const { service, source } = createHarness();
    source.getHome.mockRejectedValue(new Error('upstream unavailable'));

    const response = await service.getHome();

    expect(response.data.featured).toHaveLength(1);
    expect(response.data.recentEpisodes).toHaveLength(1);
    expect(response.data.recentEpisodes[0]?.episode.number).toBe(7);
    expect(response.meta.stale).toBe(true);
  });

  it('bounds the wait and serves last-good data while a slow refresh continues', async () => {
    vi.useFakeTimers();
    const { service, source } = createHarness();
    source.getHome.mockImplementation(() => new Promise<SourceHome>(() => {}));

    const responsePromise = service.getHome();
    await vi.advanceTimersByTimeAsync(HOME_REQUEST_REFRESH_TIMEOUT_MS + 1);
    const response = await responsePromise;

    expect(response.data.recentEpisodes).toHaveLength(1);
    expect(response.data.recentEpisodes[0]?.episode.number).toBe(7);
    expect(response.meta.stale).toBe(true);
  });
});
