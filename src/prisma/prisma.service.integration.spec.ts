import { Controller, Get, Module, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { describe } from 'vitest';
import {
  ProblemDetailsFilter,
  RETRY_AFTER_SECONDS,
} from '../common/problem-details.filter';
import { createFastifyAdapter } from '../fastify-adapter';
import { DATABASE_LIMITS, PrismaService } from './prisma.service';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `limits_test_${crypto.randomUUID().replaceAll('-', '')}`;

function serviceFor(url: string) {
  return new PrismaService(new ConfigService({ DATABASE_URL: url }));
}

function listen(server: Server) {
  return new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

// Accepts the TCP connection and stays silent: what a black-holed or frozen
// PostgreSQL looks like once the handshake starts.
async function silentServer() {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  const port = await listen(server);
  return {
    url: `postgresql://u:p@127.0.0.1:${port}/db`,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Forwards to the database until frozen: the connection stays open but
// nothing comes back, like a database that froze mid-session.
async function freezableProxy(databaseUrl: string) {
  const target = new URL(databaseUrl);
  const sockets: Socket[] = [];
  let frozen = false;
  const proxy = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    sockets.push(client, upstream);
    client.on('data', (chunk) => !frozen && upstream.write(chunk));
    upstream.on('data', (chunk) => !frozen && client.write(chunk));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  const port = await listen(proxy);
  const url = new URL(databaseUrl);
  url.host = `127.0.0.1:${port}`;
  return {
    url: url.toString(),
    freeze: () => (frozen = true),
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}

async function elapsed(work: Promise<unknown>) {
  const start = Date.now();
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return { error, ms: Date.now() - start };
}

// Margin for the timer, the error mapping and a loaded machine.
const SLACK_MS = 2_000;

describe.concurrent('main pool limits', () => {
  it('gives up connecting to a server that never answers within the connect limit', async () => {
    const silent = await silentServer();
    const prisma = serviceFor(silent.url);
    try {
      const { error, ms } = await elapsed(prisma.$queryRaw`SELECT 1`);
      expect(error).toBeInstanceOf(Error);
      expect(ms).toBeGreaterThanOrEqual(
        DATABASE_LIMITS.connectionTimeoutMillis - 100,
      );
      expect(ms).toBeLessThan(
        DATABASE_LIMITS.connectionTimeoutMillis + SLACK_MS,
      );
    } finally {
      await prisma.onModuleDestroy().catch(() => undefined);
      await silent.close();
    }
  }, 15_000);

  describe.skipIf(!testUrl)('against PostgreSQL', () => {
    it('cancels a statement past the statement limit and keeps the pool usable', async () => {
      const prisma = serviceFor(testUrl!);
      try {
        const { error, ms } = await elapsed(
          prisma.$queryRaw`SELECT pg_sleep(60)`,
        );
        expect(String(error)).toMatch(/statement timeout|57014/i);
        expect(ms).toBeGreaterThanOrEqual(
          DATABASE_LIMITS.statement_timeout - 100,
        );
        expect(ms).toBeLessThan(DATABASE_LIMITS.statement_timeout + SLACK_MS);
        await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([
          { ok: 1 },
        ]);
      } finally {
        await prisma.onModuleDestroy();
      }
    }, 30_000);

    it('fails a query the database stops answering at the query limit', async () => {
      const proxy = await freezableProxy(testUrl!);
      const prisma = serviceFor(proxy.url);
      try {
        await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([
          { ok: 1 },
        ]);
        proxy.freeze();
        const { error, ms } = await elapsed(prisma.$queryRaw`SELECT 1 AS ok`);
        expect(String(error)).toMatch(/timeout/i);
        expect(ms).toBeGreaterThanOrEqual(DATABASE_LIMITS.query_timeout - 100);
        expect(ms).toBeLessThan(DATABASE_LIMITS.query_timeout + SLACK_MS);
      } finally {
        await prisma.onModuleDestroy().catch(() => undefined);
        await proxy.close();
      }
    }, 30_000);
  });
});

// Each route runs one scenario with the errors Prisma and pg really throw.
const scenarios = new Map<string, () => Promise<unknown>>();

@Controller('scenario')
class ScenarioController {
  @Get(':name')
  run(@Param('name') name: string) {
    return scenarios.get(name)!();
  }
}

@Module({ controllers: [ScenarioController] })
class ScenarioModule {}

describe.skipIf(!testUrl)('HTTP status when a database limit trips', () => {
  let app: NestFastifyApplication;
  let admin: Pool;
  const cleanups: Array<() => Promise<unknown>> = [];

  // A service whose pool is torn down with the suite.
  function track(prisma: PrismaService) {
    cleanups.push(() => prisma.onModuleDestroy().catch(() => undefined));
    return prisma;
  }

  async function statusOf(name: string) {
    const response = await app.inject({ url: `/scenario/${name}` });
    return { response, problem: response.json<{ detail: string }>() };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: testUrl });
    const connection = await admin.connect();
    try {
      await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET search_path TO "${schema}"`);
      const migrations = resolve('prisma/migrations');
      for (const directory of (await readdir(migrations))
        .filter((name) => /^\d/.test(name))
        .sort()) {
        await connection.query(
          await readFile(
            resolve(migrations, directory, 'migration.sql'),
            'utf8',
          ),
        );
      }
    } finally {
      connection.release();
    }
    app = await NestFactory.create<NestFastifyApplication>(
      ScenarioModule,
      createFastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 30_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    await app?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  describe.concurrent('answers 503 with Retry-After', () => {
    const expect503 = ({
      response,
      problem,
    }: Awaited<ReturnType<typeof statusOf>>) => {
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS));
      expect(problem.detail).toBe('The database is temporarily unavailable.');
    };

    it('when the connection cannot be made (raw, model and transaction)', async () => {
      const silent = await silentServer();
      cleanups.push(silent.close);
      const prisma = track(serviceFor(silent.url));
      scenarios.set('connect-raw', () => prisma.$queryRaw`SELECT 1`);
      scenarios.set('connect-model', () => prisma.anime.findMany());
      scenarios.set('connect-tx', () =>
        prisma.$transaction((tx) => tx.anime.findMany()),
      );

      for (const result of await Promise.all(
        ['connect-raw', 'connect-model', 'connect-tx'].map(statusOf),
      )) {
        expect503(result);
      }
    }, 30_000);

    it('when a raw or model statement passes the statement limit', async () => {
      // A held table lock makes an ordinary findMany wait until PostgreSQL
      // cancels it at statement_timeout.
      const locker = await admin.connect();
      await locker.query('BEGIN');
      await locker.query(
        `LOCK TABLE "${schema}"."Anime" IN ACCESS EXCLUSIVE MODE`,
      );
      const url = new URL(testUrl!);
      url.searchParams.set('schema', schema);
      const prisma = track(serviceFor(url.toString()));
      scenarios.set(
        'statement-raw',
        () => prisma.$queryRaw`SELECT pg_sleep(60)`,
      );
      scenarios.set('statement-model', () => prisma.anime.findMany());
      scenarios.set('statement-tx', () =>
        prisma.$transaction((tx) => tx.anime.findMany()),
      );
      try {
        for (const result of await Promise.all(
          ['statement-raw', 'statement-model', 'statement-tx'].map(statusOf),
        )) {
          expect503(result);
        }
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
      }
    }, 40_000);

    it('when the database freezes mid-session (raw, model and transaction)', async () => {
      const proxy = await freezableProxy(testUrl!);
      cleanups.push(proxy.close);
      const url = new URL(proxy.url);
      url.searchParams.set('schema', schema);
      const prisma = track(serviceFor(url.toString()));
      await prisma.$queryRaw`SELECT 1`;
      proxy.freeze();
      scenarios.set('frozen-raw', () => prisma.$queryRaw`SELECT 1`);
      scenarios.set('frozen-model', () => prisma.episode.findMany());
      scenarios.set('frozen-tx', () =>
        prisma.$transaction((tx) => tx.episode.findMany()),
      );

      for (const result of await Promise.all(
        ['frozen-raw', 'frozen-model', 'frozen-tx'].map(statusOf),
      )) {
        expect503(result);
      }
    }, 40_000);

    it('when every pooled connection is busy past the connect limit', async () => {
      const url = new URL(testUrl!);
      url.searchParams.set('schema', schema);
      const prisma = track(serviceFor(url.toString()));
      // pg's default pool holds 10 connections; keep them all busy (Prisma
      // queries only start once awaited or chained).
      const busy = Array.from({ length: 10 }, () =>
        prisma.$queryRaw`SELECT pg_sleep(8)::text`.then(() => undefined),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      scenarios.set('pool-model', () => prisma.episode.findMany());

      expect503(await statusOf('pool-model'));
      await Promise.all(busy);
    }, 40_000);
  });
});
