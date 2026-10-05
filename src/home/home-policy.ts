export const HOME_READ_TIMEOUT_MS = 2_000;
export const HOME_REFRESH_TIMEOUT_MS = 15_000;
export const HOME_LEASE_MS = 30_000;
export const HOME_RECENT_REFRESH_INTERVAL_MS = 3 * 60_000;
export const HOME_FULL_REFRESH_INTERVAL_MS = 10 * 60_000;
export const HOME_RETRY_INTERVAL_MS = 30_000;
export const HOME_MAX_BACKOFF_MS = 5 * 60_000;
export type HomeRefreshMode = 'full' | 'recent';
export function homeBackoffMs(failures: number) {
  return Math.min(
    HOME_RETRY_INTERVAL_MS * 2 ** Math.max(0, failures - 1),
    HOME_MAX_BACKOFF_MS,
  );
}
