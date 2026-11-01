import { Prisma } from '../generated/prisma/client';

// pg 8.23 raises these three itself, with no code or class to tell them apart
// (Prisma passes them on as plain Errors); pg is pinned to 8.x in package.json.
const PG_TIMEOUTS = new Map([
  ['Connection terminated due to connection timeout', 'connection timeout'],
  ['timeout exceeded when trying to connect', 'connection pool timeout'],
  ['Query read timeout', 'query timeout'],
]);

/**
 * Why the database did not answer within the limits of DATABASE_LIMITS, or
 * null when the error is anything else.
 * - statement_timeout: PostgreSQL's SQLSTATE 57014, which Prisma carries as
 *   P2010 (raw queries) or P2039 (model queries) with the driver error in
 *   meta, so it is read from there and not from the message.
 * - P2028: an interactive transaction that could not start or ran out of time.
 */
export function databaseUnavailableReason(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2028') return 'transaction timeout';
    const driver = error.meta?.driverAdapterError as
      { cause?: { originalCode?: unknown } } | undefined;
    return driver?.cause?.originalCode === '57014' ? 'statement timeout' : null;
  }
  return error instanceof Error
    ? (PG_TIMEOUTS.get(error.message) ?? null)
    : null;
}
