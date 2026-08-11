import { nextAnimeRefresh } from './projection.service';

describe('projection freshness', () => {
  const now = new Date('2026-08-10T12:00:00.000Z');

  it('uses short intervals for airing and upcoming titles', () => {
    expect(nextAnimeRefresh('AIRING', now).toISOString()).toBe(
      '2026-08-10T12:15:00.000Z',
    );
    expect(nextAnimeRefresh('UPCOMING', now).toISOString()).toBe(
      '2026-08-10T18:00:00.000Z',
    );
  });

  it('backs off unchanged finished titles up to 180 days', () => {
    expect(nextAnimeRefresh('FINISHED', now, 0).getTime() - now.getTime()).toBe(
      30 * 24 * 60 * 60_000,
    );
    expect(nextAnimeRefresh('FINISHED', now, 1).getTime() - now.getTime()).toBe(
      60 * 24 * 60 * 60_000,
    );
    expect(nextAnimeRefresh('FINISHED', now, 5).getTime() - now.getTime()).toBe(
      180 * 24 * 60 * 60_000,
    );
  });
});
