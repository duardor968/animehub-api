import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { vi, describe } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { HomeStore, HOME_LEASE_KEY, HomeLeaseLostError } from './home-store';
import type { SourceAnimeSummary, SourceHome } from '../source/source.types';
import { SnapshotKind } from '../generated/prisma/enums';
import { serializeAnime } from '../common/serializers';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `home_test_${randomUUID().replaceAll('-', '')}`;
const anime: SourceAnimeSummary = {
  id: 'one',
  slug: 'one',
  title: 'One',
  synopsis: 'Original synopsis',
  posterUrl: 'https://cdn.test/one.jpg',
  backdropUrl: 'https://cdn.test/backdrop.jpg',
  category: null,
  genres: [],
  status: 'AIRING',
  startDate: null,
  mature: false,
};
const feed = (number = 1): SourceHome => ({
  featured: [anime],
  recentAnime: [anime],
  recentEpisodes: [
    {
      anime,
      episode: {
        id: `episode-${number}`,
        number,
        title: `Episode ${number}`,
        imageUrl: 'https://cdn.test/episode.jpg',
        sourcePath: `/media/one/${number}`,
        publishedAt: new Date('2026-10-01T00:00:00Z'),
      },
    },
  ],
});

describe.skipIf(!testUrl)(
  'HomeStore PostgreSQL integration (isolated schema)',
  () => {
    let admin: Pool;
    let prisma: PrismaService;
    let projection: ProjectionService;
    let first: HomeStore;
    let second: HomeStore;

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
      const url = new URL(testUrl!);
      url.searchParams.set('schema', schema);
      url.searchParams.set('options', '-c timezone=America/New_York');
      const config = new ConfigService({ DATABASE_URL: url.toString() });
      prisma = new PrismaService(config);
      projection = new ProjectionService(prisma);
      first = new HomeStore(config, projection);
      second = new HomeStore(config, projection);
    }, 30_000);

    beforeEach(async () => {
      await prisma.snapshotItem.deleteMany();
      await prisma.snapshot.deleteMany();
      await prisma.episode.deleteMany();
      await prisma.anime.deleteMany();
      await prisma.homeRefreshLease.deleteMany();
    });

    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await Promise.all([
        first?.onModuleDestroy(),
        second?.onModuleDestroy(),
        prisma?.onModuleDestroy(),
      ]);
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });

    async function publish(home = feed(), store = first) {
      const lease = await store.acquire();
      expect(lease).not.toBeNull();
      return store.publish(
        home,
        'full',
        lease!,
        new AbortController().signal,
        Date.now() + 15_000,
      );
    }

    it('grants exactly one lease to two competing owners, even on first startup', async () => {
      const results = await Promise.all([first.acquire(), second.acquire()]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('fences an expired owner and rejects its publication and release after reacquisition', async () => {
      const old = (await first.acquire())!;
      await prisma.homeRefreshLease.update({
        where: { key: HOME_LEASE_KEY },
        data: { expiresAt: new Date(0) },
      });
      const current = (await second.acquire())!;
      expect(current.token).not.toBe(old.token);
      await expect(
        first.publish(
          feed(),
          'full',
          old,
          new AbortController().signal,
          Date.now() + 15_000,
        ),
      ).rejects.toBeInstanceOf(HomeLeaseLostError);
      await first.release(old, true);
      expect(
        (
          await prisma.homeRefreshLease.findUniqueOrThrow({
            where: { key: HOME_LEASE_KEY },
          })
        ).token,
      ).toBe(current.token);
      await second.publish(
        feed(),
        'full',
        current,
        new AbortController().signal,
        Date.now() + 15_000,
      );
      expect(await first.read()).toHaveLength(3);
    });

    it('publishes all sections and their relational records atomically with shared freshness', async () => {
      const timezone = await prisma.$queryRaw<
        { timezone: string }[]
      >`SELECT current_setting('TimeZone') AS timezone`;
      expect(timezone[0].timezone).toBe('America/New_York');
      await publish();
      const snapshots = await second.read();
      expect(snapshots).toHaveLength(3);
      // The test database may use a non-UTC timezone. Freshness must still be
      // absolute UTC time, rather than the server's timezone-naive wall clock.
      expect(
        Math.abs(snapshots[0].fetchedAt.getTime() - Date.now()),
      ).toBeLessThan(5_000);
      expect(
        new Set(snapshots.map((entry) => entry.fetchedAt.toISOString())).size,
      ).toBe(1);
      for (const snapshot of snapshots) {
        expect(snapshot.items).toHaveLength(1);
        expect(snapshot.items[0].anime.title).toBe('One');
        expect(
          snapshot.nextRefreshAt.getTime() - snapshot.fetchedAt.getTime(),
        ).toBe(
          snapshot.kind === SnapshotKind.HOME_RECENT_EPISODES
            ? 180_000
            : 600_000,
        );
      }
    });

    it('preserves empty sections and their freshness while publishing valid episodes', async () => {
      await publish();
      const before = await first.read();
      const next = feed(2);
      next.featured = [];
      next.recentAnime = [];
      expect(await publish(next)).toEqual({ published: 1, partial: true });
      const after = await second.read();
      for (const kind of [
        SnapshotKind.HOME_FEATURED,
        SnapshotKind.HOME_RECENT_ANIME,
      ]) {
        const previous = before.find((entry) => entry.kind === kind)!;
        const current = after.find((entry) => entry.kind === kind)!;
        expect(current.fetchedAt).toEqual(previous.fetchedAt);
        expect(current.nextRefreshAt).toEqual(previous.nextRefreshAt);
        expect(
          current.items.map((item) => ({
            animeId: item.animeId,
            position: item.position,
            anime: serializeAnime(item.anime),
          })),
        ).toEqual(
          previous.items.map((item) => ({
            animeId: item.animeId,
            position: item.position,
            anime: serializeAnime(item.anime),
          })),
        );
      }
      expect(
        after.find((entry) => entry.kind === SnapshotKind.HOME_RECENT_EPISODES)
          ?.items[0].episode?.number,
      ).toBe(2);
      expect(await first.acquire()).toBeNull();
      const lease = await prisma.homeRefreshLease.findUniqueOrThrow({
        where: { key: HOME_LEASE_KEY },
      });
      expect(lease.failures).toBe(1);
      expect(lease.nextAttemptAt.getTime() - lease.expiresAt.getTime()).toBe(
        30_000,
      );
    });

    it('rolls back both record updates and previously written sections if a later section fails', async () => {
      await publish();
      const before = await first.read();
      const next = feed(2);
      next.featured = [{ ...anime, title: 'Must roll back' }];
      next.recentAnime = [{ ...anime, id: 'conflicting-source-id' }];
      await expect(publish(next)).rejects.toThrow();
      expect(await second.read()).toEqual(before);
      expect(
        await prisma.episode.findUnique({ where: { sourceId: 'episode-2' } }),
      ).toBeNull();
    });

    it('a cancelled refresh cannot publish, and a mid-publication abort rolls back its writes', async () => {
      await publish();
      const before = await first.read();
      const controller = new AbortController();
      const original = projection.upsertEpisode.bind(projection);
      vi.spyOn(projection, 'upsertEpisode').mockImplementation(
        async (...args) => {
          const result = await original(...args);
          controller.abort();
          return result;
        },
      );
      const lease = (await first.acquire())!;
      await expect(
        first.publish(
          feed(2),
          'full',
          lease,
          controller.signal,
          Date.now() + 15_000,
        ),
      ).rejects.toThrow();
      expect(await second.read()).toEqual(before);
    });

    it('serves published core during enrichment and preserves known optional metadata', async () => {
      const lease = (await first.acquire())!;
      await first.publish(
        feed(),
        'full',
        lease,
        new AbortController().signal,
        Date.now() + 15_000,
        false,
      );
      const before = await second.read();
      expect(before).toHaveLength(3);
      expect(await second.acquire()).toBeNull();
      await prisma.anime.update({
        where: { sourceId: anime.id },
        data: {
          trailerUrl: 'https://www.youtube.com/watch?v=test',
          episodeCount: 12,
        },
      });
      await first.enrichDetail(
        {
          ...anime,
          synopsis: null,
          alternativeTitle: null,
          trailerUrl: null,
          endDate: null,
          nextEpisodeAt: null,
          episodeCount: null,
          score: null,
          votes: null,
          episodes: [],
          relations: [],
        },
        lease,
        new AbortController().signal,
        Date.now() + 15_000,
      );
      const after = await second.read();
      const record = after[0].items[0].anime;
      expect(record.synopsis).toBe(anime.synopsis);
      expect(record.trailerUrl).toBe('https://www.youtube.com/watch?v=test');
      expect(record.episodeCount).toBe(12);
      expect(after.map((snapshot) => snapshot.fetchedAt)).toEqual(
        before.map((snapshot) => snapshot.fetchedAt),
      );
      await first.release(lease, false);
      expect(await second.acquire()).not.toBeNull();
    });

    it('keeps readers on the old complete generation while a transaction is in progress', async () => {
      await publish();
      const before = await second.read();
      let entered!: () => void;
      let continueWrite!: () => void;
      const paused = new Promise<void>((done) => {
        entered = done;
      });
      const resume = new Promise<void>((done) => {
        continueWrite = done;
      });
      const original = projection.upsertEpisode.bind(projection);
      vi.spyOn(projection, 'upsertEpisode').mockImplementation(
        async (...args) => {
          entered();
          await resume;
          return original(...args);
        },
      );
      const writing = publish(feed(2));
      await paused;
      expect(await second.read()).toEqual(before);
      continueWrite();
      await writing;
      expect(
        (await second.read()).find(
          (entry) => entry.kind === SnapshotKind.HOME_RECENT_EPISODES,
        )?.items[0].episode?.number,
      ).toBe(2);
    });

    it('bounds a blocked SQL read and cancels it on the PostgreSQL server', async () => {
      await publish();
      const connection = await admin.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          `LOCK TABLE "${schema}"."Snapshot" IN ACCESS EXCLUSIVE MODE`,
        );
        const start = performance.now();
        await expect(first.read()).rejects.toThrow();
        expect(performance.now() - start).toBeLessThan(2_500);
        const active = await admin.query(
          "SELECT query FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%Snapshot%' AND pid <> pg_backend_pid()",
        );
        expect(active.rows).toEqual([]);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
    });
  },
);
