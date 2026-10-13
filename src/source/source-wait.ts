/**
 * The longest a request waits for the source. A cold page takes under 2 s
 * while the source is healthy (measured), the Web gives up at 15 s, and the
 * rest of the response needs time too.
 */
export const SOURCE_WAIT_MS = 8_000;

/** The moment a request starting now stops waiting for the source. */
export function sourceDeadline() {
  return Date.now() + SOURCE_WAIT_MS;
}

/**
 * Lets a request wait for work that refreshes stored data from the source,
 * until `deadline`. The work goes on afterwards and stores its result for
 * later requests (callers keep it single-flight). Resolves false when the
 * deadline came first; a failure before it rejects as the work did.
 */
export async function waitForSource(
  work: Promise<unknown>,
  deadline = sourceDeadline(),
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), deadline - Date.now());
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
