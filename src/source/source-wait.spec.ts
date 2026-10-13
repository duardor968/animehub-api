import { vi } from 'vitest';
import { SOURCE_WAIT_MS, waitForSource } from './source-wait';

describe('waitForSource', () => {
  afterEach(() => vi.useRealTimers());

  it('reports work that ends in time, and rejects as work that fails in time', async () => {
    await expect(waitForSource(Promise.resolve())).resolves.toBe(true);
    await expect(
      waitForSource(Promise.reject(new Error('source down'))),
    ).rejects.toThrow('source down');
  });

  it('stops waiting at the deadline while the work goes on', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const work = new Promise<void>((resolve) => (finish = resolve));
    let waited: boolean | undefined;
    void waitForSource(work).then((result) => (waited = result));

    await vi.advanceTimersByTimeAsync(SOURCE_WAIT_MS - 1);
    expect(waited).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toBe(false);
    finish();
    await expect(work).resolves.toBeUndefined();
  });
});
