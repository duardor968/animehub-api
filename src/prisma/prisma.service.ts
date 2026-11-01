import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** The ?schema= of a connection string, if any. */
export function databaseSchema(connectionString: string) {
  const match = /[?&]schema=([^&]+)/.exec(connectionString);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Limits of the main pool, so that a database that stops answering fails the
 * request instead of holding it forever (pg has none by default).
 * - connectionTimeoutMillis: from asking the pool for a connection to having
 *   one, queueing for a free one and the TCP/auth handshake included.
 * - statement_timeout: PostgreSQL cancels the statement. Prisma already caps
 *   interactive transactions at 5 s; no plain statement is meant to run for
 *   seconds (migrations use their own connection, not this pool).
 * - query_timeout: the client gives up when the server cannot even cancel.
 *   Longer than statement_timeout so the server's clean cancellation wins
 *   whenever the server is alive. Stays under the 15 s the Web waits.
 * Home has its own, stricter pool (see HomeStore).
 */
export const DATABASE_LIMITS = {
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  query_timeout: 12_000,
} as const;

export function createPrismaAdapter(
  config: ConfigService,
  options: {
    max?: number;
    connectionTimeoutMillis?: number;
    query_timeout?: number;
    statement_timeout?: number;
    idleTimeoutMillis?: number;
  } = {},
) {
  const connectionString = config.getOrThrow<string>('DATABASE_URL');
  const schema = databaseSchema(connectionString);
  return new PrismaPg(
    { connectionString, ...options },
    schema ? { schema } : undefined,
  );
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({ adapter: createPrismaAdapter(config, DATABASE_LIMITS) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
