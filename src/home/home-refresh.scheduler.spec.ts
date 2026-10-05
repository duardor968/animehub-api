import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import {
  HOME_RECENT_REFRESH_INTERVAL_MS,
  HOME_FULL_REFRESH_INTERVAL_MS,
  HomeRefreshScheduler,
} from './home-refresh.scheduler';
import { HomeService } from './home.service';
import { HOME_RETRY_INTERVAL_MS } from './home-policy';

describe('HomeRefreshScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('checks due copies at boot and retries independently of page visits', async () => {
    vi.useFakeTimers();
    const config = {
      get: vi.fn(() => 'true'),
    } as unknown as ConfigService;
    const refreshIfDue = vi.fn(() => Promise.resolve());
    const home = {
      refreshIfDue,
      nextRefreshDelay: vi.fn(() => Promise.resolve(HOME_RETRY_INTERVAL_MS)),
    } as unknown as HomeService;
    const scheduler = new HomeRefreshScheduler(config, home);

    scheduler.onModuleInit();
    await Promise.resolve();
    expect(refreshIfDue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOME_RETRY_INTERVAL_MS);
    expect(refreshIfDue).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(HOME_RETRY_INTERVAL_MS);
    expect(refreshIfDue).toHaveBeenCalledTimes(2);
    expect(HOME_RECENT_REFRESH_INTERVAL_MS).toBe(180_000);
    expect(HOME_FULL_REFRESH_INTERVAL_MS).toBe(600_000);
  });

  it('does not start background work when jobs are disabled', () => {
    const config = {
      get: vi.fn(() => 'false'),
    } as unknown as ConfigService;
    const refreshIfDue = vi.fn(() => Promise.resolve());
    const home = {
      refreshIfDue,
      nextRefreshDelay: vi.fn(() => Promise.resolve(HOME_RETRY_INTERVAL_MS)),
    } as unknown as HomeService;
    const scheduler = new HomeRefreshScheduler(config, home);

    scheduler.onModuleInit();

    expect(refreshIfDue).not.toHaveBeenCalled();
  });
});
