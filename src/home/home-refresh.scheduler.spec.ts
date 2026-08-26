import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import {
  HOME_RECENT_REFRESH_INTERVAL_MS,
  HomeRefreshScheduler,
} from './home-refresh.scheduler';
import { HomeService } from './home.service';

describe('HomeRefreshScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('warms recent episodes at boot and keeps a three-minute cadence', async () => {
    vi.useFakeTimers();
    const config = {
      get: vi.fn(() => 'true'),
    } as unknown as ConfigService;
    const refreshRecentEpisodes = vi.fn(() => Promise.resolve());
    const home = { refreshRecentEpisodes } as unknown as HomeService;
    const scheduler = new HomeRefreshScheduler(config, home);

    scheduler.onModuleInit();
    await Promise.resolve();
    expect(refreshRecentEpisodes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOME_RECENT_REFRESH_INTERVAL_MS);
    expect(refreshRecentEpisodes).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
  });

  it('does not start background work when jobs are disabled', () => {
    const config = {
      get: vi.fn(() => 'false'),
    } as unknown as ConfigService;
    const refreshRecentEpisodes = vi.fn(() => Promise.resolve());
    const home = { refreshRecentEpisodes } as unknown as HomeService;
    const scheduler = new HomeRefreshScheduler(config, home);

    scheduler.onModuleInit();

    expect(refreshRecentEpisodes).not.toHaveBeenCalled();
  });
});
