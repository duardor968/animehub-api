import { vi } from 'vitest';
import { SnapshotKind } from '../generated/prisma/enums';
import { AnimeAv1Service } from '../source/animeav1.service';
import type {
  SourceAnimeSummary,
  SourceEpisode,
  SourceHome,
} from '../source/source.types';
import { HomeService } from './home.service';
import { HomeStore, type HomeSnapshots } from './home-store';
import { HOME_REFRESH_TIMEOUT_MS, homeBackoffMs } from './home-policy';

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
  const store = {
    read: vi.fn(() => Promise.resolve(snapshots as unknown as HomeSnapshots)),
    acquire: vi.fn(() => Promise.resolve({ token: 'owner', failures: 0 })),
    release: vi.fn(() => Promise.resolve()),
    publish: vi.fn(() => Promise.resolve({ published: 3, partial: false })),
    enrichDetail: vi.fn(() => Promise.resolve()),
  };
  const source = {
    getHome: vi.fn<() => Promise<SourceHome>>().mockResolvedValue(sourceHome),
  };
  const detail = vi.fn(() => Promise.reject(new Error('detail unavailable')));
  Object.assign(source, { getAnime: detail });
  const service = new HomeService(
    store as unknown as HomeStore,
    source as unknown as AnimeAv1Service,
  );
  return { service, source, store, snapshots, detail };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('HomeService cache-only reads and coordinated refresh', () => {
  afterEach(() => vi.useRealTimers());

  it('returns stale data to 100 visitors without awaiting one hanging source flight', async () => {
    const { service, source, store } = createHarness();
    let resolve!: (value: SourceHome) => void;
    source.getHome.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => service.getHome()),
    );
    await tick();
    expect(responses).toHaveLength(100);
    expect(
      responses.every(
        (response) =>
          response.meta.stale &&
          response.data.recentEpisodes[0].episode.number === 7,
      ),
    ).toBe(true);
    expect(source.getHome).toHaveBeenCalledTimes(1);
    expect(store.acquire).toHaveBeenCalledTimes(1);
    expect(store.read.mock.calls.length).toBeLessThanOrEqual(2);
    expect(store.publish).not.toHaveBeenCalled();
    const sameFlight = service.refreshIfDue();
    expect(service.refreshIfDue()).toBe(sameFlight);
    resolve(sourceHome);
    await sameFlight;
    expect(store.publish).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh complete copy without starting source work', async () => {
    const { service, source, store, snapshots } = createHarness();
    snapshots.forEach((snapshot) => {
      snapshot.nextRefreshAt = new Date(Date.now() + 60_000);
    });
    const response = await service.getHome();
    expect(response.meta.stale).toBe(false);
    expect(source.getHome).not.toHaveBeenCalled();
    expect(store.acquire).not.toHaveBeenCalled();
  });

  it('cold cache fails promptly and its detached failure is caught', async () => {
    const { service, source, store } = createHarness();
    store.read.mockResolvedValue([]);
    source.getHome.mockRejectedValue(new Error('upstream failure'));
    await expect(service.getHome()).rejects.toMatchObject({ status: 503 });
    await service.refreshIfDue();
    expect(store.release).toHaveBeenCalledWith(
      { token: 'owner', failures: 0 },
      true,
      expect.any(Number),
    );
    expect(store.publish).not.toHaveBeenCalled();
  });

  it('serves partial sections independently even when featured is missing', async () => {
    const { service, snapshots } = createHarness();
    snapshots.shift();
    const response = await service.getHome();
    expect(response.data.featured).toEqual([]);
    expect(response.data.recentEpisodes).toHaveLength(1);
    expect(response.data.recentAnime).toHaveLength(1);
    expect(response.meta.stale).toBe(true);
    await service.refreshIfDue();
  });

  it('marks an empty section stale instead of advertising a fresh complete home', async () => {
    const { service, snapshots } = createHarness();
    snapshots.forEach((snapshot) => {
      snapshot.nextRefreshAt = new Date(Date.now() + 60_000);
    });
    snapshots[0].items = [];
    const response = await service.getHome();
    expect(response.meta.stale).toBe(true);
    expect(response.data.recentEpisodes).toHaveLength(1);
    await service.refreshIfDue();
  });

  it('keeps the last good in-process copy stale on database failure without changing timestamps', async () => {
    const { service, snapshots, store } = createHarness();
    snapshots.forEach((snapshot) => {
      snapshot.nextRefreshAt = new Date(Date.now() + 60_000);
    });
    const first = await service.getHome();
    store.read.mockRejectedValue(new Error('DB unavailable'));
    const fallback = await service.getHome();
    expect(fallback.data).toEqual(first.data);
    expect(fallback.meta).toEqual({ ...first.meta, stale: true });
  });

  it('cold database failure returns unavailable without starting a source request', async () => {
    const { service, store, source } = createHarness();
    store.read.mockRejectedValue(new Error('DB unavailable'));
    await expect(service.getHome()).rejects.toMatchObject({ status: 503 });
    expect(source.getHome).not.toHaveBeenCalled();
  });

  it('does no source work when another replica owns the lease or durable backoff applies', async () => {
    const { service, store, source } = createHarness();
    store.acquire.mockResolvedValue(null as never);
    await service.refreshIfDue();
    expect(source.getHome).not.toHaveBeenCalled();
    expect(store.publish).not.toHaveBeenCalled();
  });

  it('selects recent-only mode when the full home is fresh', async () => {
    const { service, snapshots, store } = createHarness();
    snapshots
      .filter((snapshot) => snapshot.kind !== SnapshotKind.HOME_RECENT_EPISODES)
      .forEach((snapshot) => {
        snapshot.nextRefreshAt = new Date(Date.now() + 60_000);
      });
    await service.refreshIfDue();
    expect(store.publish).toHaveBeenCalledWith(
      sourceHome,
      'recent',
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Number),
      false,
    );
  });

  it('does not scrape a fresh startup copy', async () => {
    const { service, snapshots, source, store } = createHarness();
    snapshots.forEach((snapshot) => {
      snapshot.nextRefreshAt = new Date(Date.now() + 60_000);
    });
    await service.refreshIfDue();
    expect(source.getHome).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith(
      { token: 'owner', failures: 0 },
      false,
    );
  });

  it('aborts source work at the aggregate deadline and cannot publish late results', async () => {
    vi.useFakeTimers();
    const { service, source, store } = createHarness();
    let signal!: AbortSignal;
    source.getHome.mockImplementation(((value: AbortSignal) => {
      signal = value;
      return new Promise((_resolve, reject) =>
        value.addEventListener(
          'abort',
          () =>
            reject(
              value.reason instanceof Error
                ? value.reason
                : new Error('Aborted'),
            ),
          {
            once: true,
          },
        ),
      );
    }) as never);
    const refresh = service.refreshIfDue();
    await vi.advanceTimersByTimeAsync(HOME_REFRESH_TIMEOUT_MS + 1);
    await refresh;
    expect(signal.aborted).toBe(true);
    expect(store.publish).not.toHaveBeenCalled();
  });

  it('publishes core before optional details finish and still serves readers', async () => {
    const { service, store, detail } = createHarness();
    let rejectDetail!: (error: Error) => void;
    detail.mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectDetail = reject;
        }),
    );
    const refreshing = service.refreshIfDue();
    await tick();
    expect(store.publish).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(store.publish.mock.invocationCallOrder[0]).toBeLessThan(
      detail.mock.invocationCallOrder[0],
    );
    expect((await service.getHome()).data.featured).toHaveLength(1);
    rejectDetail(new Error('optional detail failed'));
    await refreshing;
    expect(store.publish).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledWith(
      { token: 'owner', failures: 0 },
      false,
      expect.any(Number),
    );
  });

  it('aborts optional enrichment inside the same deadline without undoing published core', async () => {
    vi.useFakeTimers();
    const { service, store, detail } = createHarness();
    let signal!: AbortSignal;
    detail.mockImplementation(((_slug: string, value: AbortSignal) => {
      signal = value;
      return new Promise<never>((_resolve, reject) =>
        value.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    }) as never);
    const refreshing = service.refreshIfDue();
    await vi.advanceTimersByTimeAsync(HOME_REFRESH_TIMEOUT_MS + 1);
    await refreshing;
    expect(signal.aborted).toBe(true);
    expect(store.publish).toHaveBeenCalledTimes(1);
    expect(store.enrichDetail).not.toHaveBeenCalled();
  });

  it('schedules the next durable due date, including full home between episode refreshes', async () => {
    vi.useFakeTimers();
    const { service, snapshots } = createHarness();
    snapshots.forEach((snapshot) => {
      snapshot.nextRefreshAt = new Date(Date.now() + 180_000);
    });
    snapshots[0].nextRefreshAt = new Date(Date.now() + 45_000);
    expect(await service.nextRefreshDelay()).toBe(45_000);
    snapshots[0].items = [];
    expect(await service.nextRefreshDelay()).toBe(30_000);
  });

  it('backs off locally on database acquisition failure and caps retries at five minutes', async () => {
    vi.useFakeTimers();
    const { service, store } = createHarness();
    store.acquire.mockRejectedValue(new Error('DB unavailable'));
    await service.refreshIfDue();
    await service.refreshIfDue();
    expect(store.acquire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await service.refreshIfDue();
    expect(store.acquire).toHaveBeenCalledTimes(2);
    expect([1, 2, 3, 4, 5, 6, 30].map(homeBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
  });
});
