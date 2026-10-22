import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { AnimeService } from '../anime/anime.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { SourceAnimeDetail } from '../source/source.types';
import { ProjectionService } from './projection.service';
import { RelationDiscoveryScheduler } from './relation-discovery.scheduler';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `relations_test_${randomUUID().replaceAll('-', '')}`;
const detail = (slug: string): SourceAnimeDetail => ({
  id: slug,
  slug,
  title: slug,
  synopsis: 'Synopsis',
  posterUrl: 'https://cdn.test/poster.jpg',
  backdropUrl: 'https://cdn.test/back.jpg',
  category: null,
  genres: [],
  status: 'FINISHED',
  startDate: null,
  mature: false,
  alternativeTitle: null,
  trailerUrl: null,
  endDate: null,
  nextEpisodeAt: null,
  episodeCount: 0,
  score: null,
  votes: null,
  episodes: [],
  relations: [],
});

describe.skipIf(!testUrl)(
  'relation discovery PostgreSQL integration (isolated schema)',
  () => {
    let admin: Pool;
    let prisma: PrismaService;
    let projection: ProjectionService;
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
      prisma = new PrismaService(
        new ConfigService({ DATABASE_URL: url.toString() }),
      );
      projection = new ProjectionService(prisma);
    }, 30_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it('discovers new→old from a recent snapshot, preserves old→new, and keeps unrelated titles separate', async () => {
      const old = detail('old-finished');
      const other = detail('other-franchise');
      await projection.upsertDetail(old);
      await projection.upsertDetail(other);
      const newer = detail('new-season');
      newer.relations = [
        { kind: 'PREQUEL', anime: old },
        { kind: 'SIDE_STORY', anime: other },
      ];
      const unrelated = detail('unrelated');
      const seen = await Promise.all(
        [newer, unrelated].map((entry) => projection.upsertAnime(entry)),
      );
      await projection.replaceSnapshot(
        'home:discovery-test',
        'HOME_RECENT_ANIME',
        seen.map((entry) => ({ animeId: entry.id })),
        { ttlMinutes: 10 },
      );
      const source = {
        getAnime: vi.fn((slug: string) =>
          Promise.resolve(slug === newer.slug ? newer : unrelated),
        ),
      };
      const worker = new RelationDiscoveryScheduler(
        new ConfigService({ JOBS_ENABLED: 'false' }),
        prisma,
        source as unknown as AnimeAv1Service,
        projection,
      );
      await worker.refreshObserved();
      const api = new AnimeService(
        prisma,
        projection,
        source as unknown as AnimeAv1Service,
      );
      const storedOld = await api.getAnime(old.slug);
      expect(storedOld.data.relations).toEqual([]);
      expect(storedOld.data.incomingRelations).toMatchObject([
        { kind: 'PREQUEL', anime: { slug: newer.slug } },
      ]);
      expect(
        (await api.getAnime(other.slug)).data.incomingRelations,
      ).toMatchObject([{ kind: 'SIDE_STORY', anime: { slug: newer.slug } }]);
      expect((await api.getAnime(unrelated.slug)).data).toMatchObject({
        relations: [],
        incomingRelations: [],
      });
      expect(source.getAnime.mock.calls.map(([slug]) => slug).sort()).toEqual(
        [newer.slug, unrelated.slug].sort(),
      );
      // A source-authored reverse edge is retained separately, never synthesized.
      old.relations = [{ kind: 'SEQUEL', anime: newer }];
      await projection.upsertDetail(old);
      expect((await api.getAnime(old.slug)).data.relations).toMatchObject([
        { kind: 'SEQUEL', anime: { slug: newer.slug } },
      ]);
      await worker.refreshObserved();
      expect(source.getAnime).toHaveBeenCalledTimes(2);
    });

    it('keeps the last graph and freshness when a replacement fails', async () => {
      const owner = detail('rollback-owner');
      const target = detail('rollback-target');
      const edge = { kind: 'PREQUEL' as const, anime: target };
      owner.relations = [edge];
      await projection.upsertDetail(owner);
      const before = await prisma.anime.findUniqueOrThrow({
        where: { slug: owner.slug },
      });
      owner.relations = [edge, edge]; // Violates the source/target/kind uniqueness constraint.
      await expect(projection.upsertDetail(owner)).rejects.toThrow();
      expect(
        await prisma.animeRelation.count({
          where: { sourceAnimeId: before.id },
        }),
      ).toBe(1);
      const after = await prisma.anime.findUniqueOrThrow({
        where: { slug: owner.slug },
      });
      expect(after.detailFetchedAt).toEqual(before.detailFetchedAt);
      expect(after.contentHash).toBe(before.contentHash);
    });
  },
);
