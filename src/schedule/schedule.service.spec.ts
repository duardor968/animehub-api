import {
  isDegradedScrape,
  retainOmittedEntries,
  SCHEDULE_RETENTION_MS,
  type RetainableScheduleItem,
} from './schedule.service';

describe('schedule retention policy', () => {
  const now = new Date('2026-08-17T13:00:00.000Z');
  const prevFetchedAt = new Date(now.getTime() - 60_000); // 1 min ago

  const item = (
    animeId: string,
    label: string | null,
    episodeId: string | null = `ep-${animeId}`,
  ): RetainableScheduleItem => ({ animeId, episodeId, label });

  const seenMinutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();

  it('retains a still-airing show the source transiently omitted', () => {
    // The source returned a and b this cycle but dropped c (a Monday-morning
    // rollover blip); c was listed 5 min ago, well within the window.
    const seen = new Set(['a', 'b']);
    const previous = [
      item('a', seenMinutesAgo(0.5)),
      item('c', seenMinutesAgo(5)),
    ];

    const retained = retainOmittedEntries(seen, previous, prevFetchedAt, now);

    expect(retained.map((entry) => entry.animeId)).toEqual(['c']);
    // Carries the show's own episode and preserves its original last-seen stamp
    // so the retention clock keeps counting from when the source last listed it.
    expect(retained[0].episodeId).toBe('ep-c');
    expect(retained[0].label).toBe(seenMinutesAgo(5));
  });

  it('drops a show the source has not listed for longer than the window', () => {
    const seen = new Set(['a']);
    const staleLabel = new Date(
      now.getTime() - (SCHEDULE_RETENTION_MS + 60_000),
    ).toISOString();

    expect(
      retainOmittedEntries(seen, [item('c', staleLabel)], prevFetchedAt, now),
    ).toEqual([]);
  });

  it('never re-adds a show already present in the source response', () => {
    const seen = new Set(['a', 'c']);

    expect(
      retainOmittedEntries(
        seen,
        [item('c', seenMinutesAgo(5))],
        prevFetchedAt,
        now,
      ),
    ).toEqual([]);
  });

  it('treats a legacy item with no last-seen label as seen at the snapshot fetch time', () => {
    const seen = new Set<string>();

    const retained = retainOmittedEntries(
      seen,
      [item('c', null)],
      prevFetchedAt,
      now,
    );

    // prevFetchedAt is within the window, so the legacy item is retained and
    // stamped with the fetch time as its baseline last-seen.
    expect(retained.map((entry) => entry.animeId)).toEqual(['c']);
    expect(retained[0].label).toBe(prevFetchedAt.toISOString());
  });
});

describe('degraded scrape guard', () => {
  it('accepts a full-size scrape', () => {
    expect(isDegradedScrape(77, 77)).toBe(false);
  });

  it('accepts a small, plausible day-to-day roster change', () => {
    // ~96% of the healthy count — a couple of shows finishing/joining is normal.
    expect(isDegradedScrape(74, 77)).toBe(false);
  });

  it('rejects a scrape materially smaller than the healthy snapshot', () => {
    // ~78% < 85% — a partial/degraded source response that must not shrink the board.
    expect(isDegradedScrape(60, 77)).toBe(true);
  });

  it('rejects an empty scrape when a healthy snapshot exists', () => {
    expect(isDegradedScrape(0, 77)).toBe(true);
  });

  it('accepts anything on a cold cache (no healthy baseline to protect)', () => {
    expect(isDegradedScrape(5, 0)).toBe(false);
    expect(isDegradedScrape(0, 0)).toBe(false);
  });

  it('draws the line strictly below the ratio', () => {
    expect(isDegradedScrape(85, 100, 0.85)).toBe(false);
    expect(isDegradedScrape(84, 100, 0.85)).toBe(true);
  });
});
