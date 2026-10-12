import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** The ?schema= of a connection string, if any. */
export function databaseSchema(connectionString: string) {
  const match = /[?&]schema=([^&]+)/.exec(connectionString);
  return match ? decodeURIComponent(match[1]) : undefined;
}

// Home uses a separate, small pool with strict read/job deadlines. Other API
// workflows keep their existing pool and are not delayed by home refreshes.
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
    super({ adapter: createPrismaAdapter(config) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
