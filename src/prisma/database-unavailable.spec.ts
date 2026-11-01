import { Prisma } from '../generated/prisma/client';
import { databaseUnavailableReason } from './database-unavailable';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('failed', {
    code,
    clientVersion: '7.10.0',
    meta,
  });
const statementTimeout = {
  driverAdapterError: { cause: { originalCode: '57014' } },
};

describe('databaseUnavailableReason', () => {
  it.each([
    ['raw query statement timeout', known('P2010', statementTimeout)],
    ['model query statement timeout', known('P2039', statementTimeout)],
  ])('recognizes a %s by SQLSTATE 57014', (_name, error) => {
    expect(databaseUnavailableReason(error)).toBe('statement timeout');
  });

  it('recognizes a transaction that could not start or ran out of time', () => {
    expect(databaseUnavailableReason(known('P2028'))).toBe(
      'transaction timeout',
    );
  });

  it.each([
    ['Connection terminated due to connection timeout', 'connection timeout'],
    ['timeout exceeded when trying to connect', 'connection pool timeout'],
    ['Query read timeout', 'query timeout'],
  ])('recognizes the pg timeout "%s"', (message, reason) => {
    expect(databaseUnavailableReason(new Error(message))).toBe(reason);
  });

  it.each([
    ['another Prisma error', known('P2002')],
    [
      'a database error with another SQLSTATE',
      known('P2010', {
        driverAdapterError: { cause: { originalCode: '23505' } },
      }),
    ],
    ['an unrelated Error', new Error('Query read timeout while parsing')],
    ['a non-error', 'Query read timeout'],
  ])('ignores %s', (_name, error) => {
    expect(databaseUnavailableReason(error)).toBeNull();
  });
});
