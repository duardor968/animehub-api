import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { SourceAnimeDetail } from '../source/source.types';
import { ProjectionService } from './projection.service';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `relation_concurrency_${randomUUID().replaceAll('-', '')}`;
const detail = (slug: string): SourceAnimeDetail => ({
  id: slug,
  slug,
  title: slug,
  synopsis: 'Concurrency fixture',
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
  'relation concurrency PostgreSQL integration (isolated schema)',
  () => {
    let admin: Pool;
    let prisma: PrismaService;
    let otherPrisma: PrismaService;
    let projection: ProjectionService;
    let otherProjection: ProjectionService;
    const pending = new Set<Promise<unknown>>();

    // Catalog refresh uses Promise.all: its rejection can precede the other
    // writes finishing. Drain those writes before dropping the fixture schema.
    function track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
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
        // Keep inserts overlapping even on fast CI hardware. PostgreSQL still
        // performs the real writes, foreign-key checks and lock arbitration.
        await connection.query(`
          CREATE FUNCTION pause_relation_insert() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN
            PERFORM pg_sleep(0.05);
            RETURN NEW;
          END $$;
          CREATE TRIGGER overlap_relation_inserts
          BEFORE INSERT ON "AnimeRelation"
          FOR EACH ROW EXECUTE FUNCTION pause_relation_insert();
        `);
      } finally {
        connection.release();
      }
      const url = new URL(testUrl!);
      url.searchParams.set('schema', schema);
      prisma = new PrismaService(
        new ConfigService({ DATABASE_URL: url.toString() }),
      );
      otherPrisma = new PrismaService(
        new ConfigService({ DATABASE_URL: url.toString() }),
      );
      projection = new ProjectionService(prisma);
      otherProjection = new ProjectionService(otherPrisma);
    }, 30_000);

    afterEach(async () => {
      await Promise.allSettled([...pending]);
    });

    afterAll(async () => {
      await Promise.allSettled([...pending]);
      await Promise.all([prisma?.$disconnect(), otherPrisma?.$disconnect()]);
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });

    async function reciprocalPair(prefix: string) {
      const first = detail(`${prefix}-first`);
      const second = detail(`${prefix}-second`);
      await projection.upsertDetail(first);
      await projection.upsertDetail(second);
      first.relations = [{ kind: 'SEQUEL', anime: second }];
      second.relations = [{ kind: 'PREQUEL', anime: first }];
      return [first, second] as const;
    }

    it('refreshes reciprocal relations concurrently without losing either edge', async () => {
      const [first, second] = await reciprocalPair('reciprocal');
      // Sequential control also leaves existing edges to replace concurrently.
      await projection.upsertDetail(first);
      await projection.upsertDetail(second);
      for (let round = 0; round < 4; round++) {
        const results = await Promise.allSettled([
          projection.upsertDetail(first),
          otherProjection.upsertDetail(second),
        ]);
        expect(results.map((result) => result.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
      }
      expect(
        await prisma.animeRelation.findMany({
          where: { sourceAnime: { slug: { in: [first.slug, second.slug] } } },
          select: { targetSlug: true, kind: true },
          orderBy: { targetSlug: 'asc' },
        }),
      ).toEqual([
        { targetSlug: first.slug, kind: 'PREQUEL' },
        { targetSlug: second.slug, kind: 'SEQUEL' },
      ]);
    }, 15_000);

    it('builds a cold catalog containing reciprocal seasons without a 503', async () => {
      const [first, second] = await reciprocalPair('catalog');
      const source = {
        getCatalog: () =>
          Promise.resolve({
            results: [first, second],
            totalPages: 1,
            totalRecords: 2,
            categories: [],
            genres: [],
            years: [2000, 2026],
          }),
        getAnime: (slug: string) =>
          Promise.resolve(slug === first.slug ? first : second),
      };
      const catalogProjection = new ProjectionService(prisma);
      const upsertDetail =
        catalogProjection.upsertDetail.bind(catalogProjection);
      catalogProjection.upsertDetail = (anime) => track(upsertDetail(anime));
      const catalog = new CatalogService(
        prisma,
        catalogProjection,
        source as unknown as AnimeAv1Service,
      );
      for (let page = 1; page <= 4; page++) {
        const response = await catalog.getCatalog({
          page: 1,
          search: `cold-${page}`,
        });
        expect(response.data.map((anime) => anime.slug)).toEqual([
          first.slug,
          second.slug,
        ]);
        expect(response.meta).toMatchObject({ totalRecords: 2, stale: false });
      }
    }, 15_000);

    it('keeps one complete relation set when two workers refresh the same anime', async () => {
      const owner = detail('shared-owner');
      const targets = ['one', 'two', 'three', 'four'].map((name) =>
        detail(`shared-target-${name}`),
      );
      await projection.upsertDetail(owner);
      for (const target of targets) await projection.upsertDetail(target);
      const versions = [targets.slice(0, 2), targets.slice(2)].map(
        (entries) => ({
          ...owner,
          relations: entries.map((anime) => ({
            kind: 'SEQUEL' as const,
            anime,
          })),
        }),
      );
      const empty = { ...owner, relations: [] };
      for (const pair of [
        versions,
        [versions[0], empty],
        [empty, versions[1]],
        versions,
      ]) {
        const results = await Promise.allSettled([
          projection.upsertDetail(pair[0]),
          otherProjection.upsertDetail(pair[1]),
        ]);
        expect(results.map((result) => result.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        const relations = await prisma.animeRelation.findMany({
          where: { sourceAnime: { slug: owner.slug } },
          orderBy: { position: 'asc' },
        });
        const expected = pair.map((version) =>
          version.relations.map((relation) => relation.anime.slug),
        );
        expect(expected).toContainEqual(
          relations.map((relation) => relation.targetSlug),
        );
      }
    }, 15_000);

    it.each([2, 3])(
      'bounds retries after %i PostgreSQL deadlocks and preserves atomic replacement',
      async (failures) => {
        const owner = detail(`retry-owner-${failures}`);
        const old = detail(`retry-old-${failures}`);
        owner.relations = [{ kind: 'PREQUEL', anime: old }];
        await projection.upsertDetail(owner);
        const first = detail(`retry-first-${failures}`);
        const last = detail(`retry-last-${failures}`);
        const sequence = `"${schema}".retry_attempts_${failures}`;
        // Sequence increments survive rollback, so failures count whole real
        // transaction attempts rather than calls through a mocked Prisma API.
        await admin.query(`
          CREATE SEQUENCE ${sequence};
          CREATE FUNCTION "${schema}".inject_deadlock_${failures}()
          RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW."targetSlug" = '${last.slug}' THEN
              IF nextval('${sequence}') <= ${failures} THEN
                RAISE EXCEPTION 'test deadlock' USING ERRCODE = '40P01';
              END IF;
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER inject_deadlock_${failures}
          BEFORE INSERT ON "${schema}"."AnimeRelation"
          FOR EACH ROW EXECUTE FUNCTION "${schema}".inject_deadlock_${failures}();
        `);
        owner.relations = [first, last].map((anime) => ({
          kind: 'SEQUEL',
          anime,
        }));
        const replacement = projection.upsertDetail(owner);
        if (failures === 2) await expect(replacement).resolves.toBeDefined();
        else await expect(replacement).rejects.toMatchObject({ code: 'P2034' });
        const relations = await prisma.animeRelation.findMany({
          where: { sourceAnime: { slug: owner.slug } },
          select: { targetSlug: true },
          orderBy: { position: 'asc' },
        });
        expect(relations.map((relation) => relation.targetSlug)).toEqual(
          failures === 2 ? [first.slug, last.slug] : [old.slug],
        );
        const attempts = await admin.query<{ last_value: string }>(
          `SELECT last_value FROM ${sequence}`,
        );
        expect(Number(attempts.rows[0].last_value)).toBe(3);
      },
    );
  },
);
