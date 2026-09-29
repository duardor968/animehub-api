import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { ScheduleService } from './schedule.service';

const now = new Date('2026-09-28T20:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

function harness() {
  const anime = (id: string) => ({
    id,
    sourceId: id,
    slug: id,
    title: id,
    status: 'AIRING',
    synopsis: null,
    posterUrl: null,
    backdropUrl: null,
    category: null,
    startDate: null,
    mature: false,
    episodeCount: 12,
    detailFetchedAt: hoursAgo(1),
  });
  const episode = (id: string, number = 11, publishedAt = hoursAgo(168)) => ({
    id: `${id}-${number}`,
    sourceId: `${id}-${number}`,
    animeId: id,
    number,
    publishedAt,
    title: null,
    imageUrl: null,
  });
  const animeRecords = new Map<string, ReturnType<typeof anime>>();
  const episodeRecords = new Map<string, ReturnType<typeof episode>>();
  const add = (id: string, number = 11, date = hoursAgo(168)) => {
    const a = anime(id);
    const e = episode(id, number, date);
    animeRecords.set(a.id, a);
    episodeRecords.set(e.id, e);
    return {
      animeId: id,
      episodeId: e.id,
      label: hoursAgo(200).toISOString(),
      anime: a,
      episode: e,
    };
  };
  const snapshot = {
    fetchedAt: hoursAgo(170),
    nextRefreshAt: hoursAgo(169),
    items: Array.from({ length: 48 }, (_, i) => add(`show-${i}`)),
  };
  const source = {
    getSchedule: vi.fn(() =>
      Promise.resolve(
        snapshot.items
          .slice(0, 18)
          .map((x) => ({ anime: x.anime, episode: x.episode })),
      ),
    ),
    getHome: vi.fn(() =>
      Promise.resolve({
        recentEpisodes: [] as Array<{
          anime: ReturnType<typeof anime>;
          episode: ReturnType<typeof episode>;
        }>,
      }),
    ),
    getAnime: vi.fn((slug: string) =>
      Promise.resolve({
        ...anime(slug),
        status: 'FINISHED',
      }),
    ),
  };
  const prisma = {
    snapshot: { findUnique: vi.fn(() => Promise.resolve(snapshot)) },
    anime: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    episode: {
      findFirst: vi.fn(({ where }: { where: { animeId: string } }) =>
        Promise.resolve(
          [...episodeRecords.values()]
            .filter((e) => e.animeId === where.animeId && e.publishedAt)
            .sort((a, b) => b.number - a.number)[0] ?? null,
        ),
      ),
    },
  };
  const projection = {
    upsertAnime: vi.fn((a: ReturnType<typeof anime>) => {
      if (!animeRecords.has(a.id)) animeRecords.set(a.id, a);
      return Promise.resolve(animeRecords.get(a.id)!);
    }),
    upsertEpisode: vi.fn((id: string, e: ReturnType<typeof episode>) => {
      episodeRecords.set(e.id, { ...e, animeId: id });
      return Promise.resolve(e);
    }),
    upsertDetail: vi.fn((a: ReturnType<typeof anime>) => {
      Object.assign(animeRecords.get(a.id)!, a, { detailFetchedAt: now });
      return Promise.resolve();
    }),
    replaceSnapshot: vi.fn(
      (
        _key: string,
        _kind: string,
        entries: Array<{ animeId: string; episodeId: string; label: string }>,
      ) => {
        snapshot.items = entries.map((e) => ({
          ...e,
          anime: animeRecords.get(e.animeId)!,
          episode: episodeRecords.get(e.episodeId)!,
        }));
        snapshot.fetchedAt = now;
        snapshot.nextRefreshAt = new Date(now.getTime() + 900_000);
        return Promise.resolve();
      },
    ),
  };
  const service = new ScheduleService(
    prisma as unknown as PrismaService,
    projection as unknown as ProjectionService,
    source as unknown as AnimeAv1Service,
  );
  return { service, source, projection, snapshot, add };
}

describe('schedule season rollover and finale publication', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('accepts the real 48-to-18 rollover and refreshes the first stale response', async () => {
    const h = harness();
    const result = await h.service.getSchedule();
    expect(result.data).toHaveLength(18);
    expect(result.meta.stale).toBe(false);
  });
  it('accepts a valid empty schedule instead of preserving a dead season', async () => {
    const h = harness();
    h.source.getSchedule.mockResolvedValue([]);
    expect((await h.service.getSchedule()).data).toEqual([]);
  });
  it('keeps the last snapshot stale when the source actually fails', async () => {
    const h = harness();
    h.source.getSchedule.mockRejectedValue(new Error('network'));
    const result = await h.service.getSchedule();
    expect(result.data).toHaveLength(48);
    expect(result.meta.stale).toBe(true);
    expect(h.projection.replaceSnapshot).not.toHaveBeenCalled();
  });
  it('retains a briefly missing active series without extending its last-seen clock', async () => {
    const h = harness();
    const item = h.snapshot.items[47];
    item.label = hoursAgo(1).toISOString();
    await h.service.refresh();
    expect(
      h.snapshot.items.find((x) => x.animeId === item.animeId)?.label,
    ).toBe(item.label);
    vi.setSystemTime(new Date(now.getTime() + 6 * 3_600_000));
    await h.service.refresh();
    expect(h.snapshot.items.some((x) => x.animeId === item.animeId)).toBe(
      false,
    );
  });
  it('does not retain a finished series merely because it was listed recently', async () => {
    const h = harness();
    const item = h.snapshot.items[47];
    item.label = hoursAgo(1).toISOString();
    item.anime.status = 'FINISHED';
    await h.service.refresh();
    expect(h.snapshot.items.some((x) => x.animeId === item.animeId)).toBe(
      false,
    );
  });
  it('recovers a published finale even after it left the source schedule', async () => {
    const h = harness();
    const final = h.add('liar-game', 26, hoursAgo(3));
    final.anime.episodeCount = 26;
    final.anime.detailFetchedAt = hoursAgo(170);
    h.source.getHome.mockResolvedValue({ recentEpisodes: [final] });
    h.source.getAnime.mockResolvedValue({ ...final.anime, status: 'FINISHED' });
    const result = await h.service.getSchedule();
    expect(result.data.find((x) => x.anime.slug === 'liar-game')).toMatchObject(
      { latestEpisode: { number: 26 }, isFinalEpisode: true },
    );
    expect(h.source.getAnime).toHaveBeenCalledTimes(1);
    await h.service.refresh();
    expect(h.source.getAnime).toHaveBeenCalledTimes(1);
  });
  it('does not mistake an old episode for the final based on series status alone', async () => {
    const h = harness();
    const final = h.add('incomplete', 11, hoursAgo(3));
    final.anime.status = 'FINISHED';
    final.anime.episodeCount = 12;
    h.source.getHome.mockResolvedValue({ recentEpisodes: [final] });
    expect(
      (await h.service.getSchedule()).data.some(
        (x) => x.anime.slug === 'incomplete',
      ),
    ).toBe(false);
  });
  it('bounds the wait when a source hangs', async () => {
    const h = harness();
    h.source.getSchedule.mockImplementation(() => new Promise(() => {}));
    const result = h.service.getSchedule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).meta.stale).toBe(true);
  });
  it('deduplicates overlapping refreshes', async () => {
    const h = harness();
    await Promise.all([h.service.refresh(), h.service.refresh()]);
    expect(h.source.getSchedule).toHaveBeenCalledTimes(1);
  });
  it('updates the roster even if the supplementary recent feed fails', async () => {
    const h = harness();
    h.source.getHome.mockRejectedValue(new Error('feed offline'));
    expect((await h.service.getSchedule()).data).toHaveLength(18);
  });
  it('preserves a known recent finale if it has left the recent feed', async () => {
    const h = harness();
    const item = h.add('finale', 12, hoursAgo(3));
    item.anime.status = 'FINISHED';
    h.snapshot.items.push(item);
    h.source.getHome.mockResolvedValue({ recentEpisodes: [] });
    expect(
      (await h.service.getSchedule()).data.find(
        (x) => x.anime.slug === 'finale',
      )?.isFinalEpisode,
    ).toBe(true);
  });
  it('expires an old finale even when its last-seen label is recent', async () => {
    const h = harness();
    const item = h.add('finale', 12, hoursAgo(49));
    item.anime.status = 'FINISHED';
    item.label = now.toISOString();
    h.snapshot.items.push(item);
    expect(
      (await h.service.getSchedule()).data.some(
        (x) => x.anime.slug === 'finale',
      ),
    ).toBe(false);
  });
});
