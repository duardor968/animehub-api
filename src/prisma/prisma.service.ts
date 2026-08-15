import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>('DATABASE_URL');
    // The `pg` driver ignores Prisma's `?schema=` param, so the adapter must be
    // told the schema explicitly for its generated queries. Otherwise runtime
    // queries hit `public` while `prisma migrate deploy` (which does honor
    // `?schema=`) creates the tables in the target schema — every query would
    // 500. Absent (local dev) → undefined → the default `public` schema.
    const schemaMatch = /[?&]schema=([^&]+)/.exec(connectionString);
    const schema = schemaMatch ? decodeURIComponent(schemaMatch[1]) : undefined;
    const adapter = new PrismaPg(
      { connectionString },
      schema ? { schema } : undefined,
    );

    super({ adapter });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
