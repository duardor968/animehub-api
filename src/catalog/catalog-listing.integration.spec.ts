import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { AnimeStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectionService } from '../projection/projection.service';
import { AnimeAv1Service } from '../source/animeav1.service';
import { CatalogQueryDto } from './catalog-query.dto';
import { CATALOG_PASS_KEY, CatalogService } from './catalog.service';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `catalog_test_${randomUUID().replaceAll('-', '')}`;

type Seed = {
  id: string;
  title: string;
  status: AnimeStatus;
  startDate?: string;
  votes?: number;
  score?: number;
  category: string;
  genres?: string[];
  available?: boolean;
};

// Source ids 9 < 10 < 100 as numbers, not as text.
const seeds: Seed[] = [
  {
    id: '9',
    title: 'Zeta',
    status: 'AIRING',
    startDate: '2026-04-01',
    votes: 50,
    score: 8,
    category: 'tv-anime',
    genres: ['accion', 'comedia'],
  },
  {
    id: '10',
    title: '"Kimi wo Aisuru"',
    status: 'FINISHED',
    startDate: '1985-01-01',
    votes: 500,
    score: 9,
    category: 'pelicula',
    genres: ['accion'],
  },
  {
    id: '100',
    title: '.hack//Sign',
    status: 'UPCOMING',
    startDate: '2027-01-10',
    category: 'tv-anime',
    genres: ['comedia'],
  },
  {
    id: '11',
    title: '86',
    status: 'PAUSED',
    startDate: '2021-04-11',
    votes: 500,
    score: 9,
    category: 'tv-anime',
    genres: ['accion', 'comedia', 'drama'],
  },
  {
    id: '12',
    title: 'Akira',
    status: 'FINISHED',
    startDate: '1988-07-16',
    votes: 10,
    score: 8,
    category: 'pelicula',
    genres: ['drama'],
  },
  {
    id: '13',
    title: 'kaguya-sama',
    status: 'FINISHED',
    startDate: '2019-01-12',
    votes: 20,
    score: 8.5,
    category: 'tv-anime',
    genres: ['comedia'],
  },
  {
    id: '16',
    title: 'Twin',
    status: 'FINISHED',
    startDate: '2021-04-11',
    votes: 1,
    score: 7,
    category: 'tv-anime',
  },
  {
    id: '14',
    title: 'Gone',
    status: 'FINISHED',
    startDate: '1960-01-01',
    category: 'tv-anime',
    genres: ['accion'],
    available: false,
  },
  // Accented initials, also lowercase or after a sign.
  ...['Übel Blatt', 'Éiru', 'Ōkami Kakushi', 'élan', '"Ōmuro"'].map(
    (title, index) => ({
      id: String(300 + index),
      title,
      status: 'FINISHED' as const,
      category: 'especial',
    }),
  ),
  // Word by word, leading signs and accents aside.
  ...[
    'Uchiage Hanabi',
    'Uchi no Maid',
    'Uchuujin',
    'Uchuu Kaizoku',
    '#Zombie Sagashitemasu',
    'Zombie Land Saga',
    'éclair',
    'Eden',
  ].map((title, index) => ({
    id: String(400 + index),
    title,
    status: 'FINISHED' as const,
    category: 'ona',
  })),
  // Enough of one format for several pages.
  ...Array.from({ length: 23 }, (_, index) => ({
    id: String(200 + index),
    title: `Filler ${index}`,
    status: 'FINISHED' as const,
    category: 'ova',
  })),
];
const main = { category: ['tv-anime', 'pelicula'] };

describe.skipIf(!testUrl)(
  'catalog served from PostgreSQL (isolated schema)',
  () => {
    let admin: Pool;
    let prisma: PrismaService;
    let catalog: CatalogService;
    const ids = async (query: Partial<CatalogQueryDto>) =>
      (await catalog.getCatalog({ page: 1, ...query })).data.map(
        (anime) => anime.id,
      );

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
      const config = new ConfigService({ DATABASE_URL: url.toString() });
      prisma = new PrismaService(config);
      catalog = new CatalogService(
        config,
        prisma,
        new ProjectionService(prisma),
        {} as AnimeAv1Service,
      );
      const categories = new Map<string, string>();
      for (const slug of ['tv-anime', 'pelicula', 'ova', 'especial', 'ona'])
        categories.set(
          slug,
          (
            await prisma.category.create({
              data: { sourceId: slug, name: slug, slug },
            })
          ).id,
        );
      const genres = new Map<string, string>();
      for (const slug of ['accion', 'comedia', 'drama'])
        genres.set(
          slug,
          (
            await prisma.genre.create({
              data: { sourceId: slug, name: slug, slug },
            })
          ).id,
        );
      const now = new Date();
      for (const seed of seeds)
        await prisma.anime.create({
          data: {
            sourceId: seed.id,
            slug: `anime-${seed.id}`,
            title: seed.title,
            status: seed.status,
            availability:
              seed.available === false ? 'UNAVAILABLE' : 'AVAILABLE',
            startDate: seed.startDate
              ? new Date(`${seed.startDate}T00:00:00Z`)
              : null,
            votes: seed.votes ?? null,
            score: seed.score ?? null,
            categoryId: categories.get(seed.category),
            sourceUrl: `https://animeav1.com/media/anime-${seed.id}`,
            lastSeenAt: now,
            lastFetchedAt: now,
            nextRefreshAt: now,
            genres: {
              create: (seed.genres ?? []).map((slug) => ({
                genreId: genres.get(slug)!,
              })),
            },
          },
        });
    }, 30_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it.each([
      ['latest_added', ['100', '16', '13', '12', '11', '10', '9']],
      // Numbers first by value; leading signs and case do not count.
      ['title', ['11', '12', '100', '13', '10', '16', '9']],
      // Ties go to the newest added.
      ['popular', ['11', '10', '9', '13', '12', '16', '100']],
      ['score', ['11', '10', '13', '9', '12', '16', '100']],
      // Same premiere: the first added first, as the source does.
      ['latest_released', ['100', '9', '11', '16', '13', '12', '10']],
    ])('orders by %s', async (order, expected) => {
      expect(await ids({ ...main, order })).toEqual(expected);
    });

    it('orders titles word by word, past leading signs, accents and case', async () => {
      const titles = (
        await catalog.getCatalog({ page: 1, category: ['ona'], order: 'title' })
      ).data.map((anime) => anime.title);
      expect(titles).toEqual([
        'éclair',
        'Eden',
        'Uchi no Maid',
        'Uchiage Hanabi',
        'Uchuu Kaizoku',
        'Uchuujin',
        'Zombie Land Saga',
        '#Zombie Sagashitemasu',
      ]);
    });

    it('orders by latest added without an order', async () => {
      expect(await ids(main)).toEqual(
        await ids({ ...main, order: 'latest_added' }),
      );
    });

    it.each([
      ['K', ['13', '10']],
      ['k', ['13', '10']],
      ['h', ['100']],
      ['#', ['11']],
      ['Q', []],
    ])(
      'filters by the initial %s, past leading signs',
      async (letter, expected) => {
        expect(await ids({ ...main, letter })).toEqual(expected);
      },
    );

    it.each([
      ['u', ['300']],
      ['E', ['303', '301']],
      ['o', ['304', '302']],
      ['#', []],
    ])(
      'files the accented initial %s under its base letter',
      async (letter, expected) => {
        expect(await ids({ category: ['especial'], letter })).toEqual(expected);
      },
    );

    it.each([
      ['emision', ['9']],
      ['finalizado', ['16', '13', '12', '10']],
      ['proximamente', ['100', '11']],
    ])('filters by status %s', async (status, expected) => {
      expect(await ids({ ...main, status })).toEqual(expected);
    });

    it.each([
      [{ minYear: 1980, maxYear: 1989 }, ['12', '10']],
      [{ maxYear: 1985 }, ['10']],
      [{ minYear: 2027 }, ['100']],
      [{ minYear: 2030 }, []],
    ])('filters by years %o, both ends included', async (years, expected) => {
      expect(await ids({ ...main, ...years })).toEqual(expected);
    });

    it.each([
      [['accion'], ['11', '10', '9']],
      [
        ['accion', 'comedia'],
        ['11', '9'],
      ],
      [['accion', 'comedia', 'drama'], ['11']],
      [['accion', 'unknown'], []],
    ])('keeps the anime having every genre in %o', async (genre, expected) => {
      expect(await ids({ genre })).toEqual(expected);
    });

    it('filters by any of the formats and combines every filter', async () => {
      expect(await ids({ category: ['pelicula'] })).toEqual(['12', '10']);
      expect(
        await ids({
          ...main,
          genre: ['comedia'],
          status: 'finalizado',
          letter: 'k',
        }),
      ).toEqual(['13']);
    });

    it('pages with exact totals, also past the last page, and never lists unavailable anime', async () => {
      const first = await catalog.getCatalog({ page: 1, category: ['ova'] });
      const second = await catalog.getCatalog({ page: 2, category: ['ova'] });
      const past = await catalog.getCatalog({ page: 3, category: ['ova'] });
      expect(first.data).toHaveLength(20);
      expect(second.data.map((anime) => anime.id)).toEqual([
        '202',
        '201',
        '200',
      ]);
      for (const page of [first, second, past])
        expect(page.meta).toMatchObject({
          totalRecords: 23,
          totalPages: 2,
          perPage: 20,
          capped: false,
        });
      expect(past.data).toEqual([]);
      const all = await catalog.getCatalog({ page: 1 });
      expect(all.meta.totalRecords).toBe(43);
      expect(await ids({ letter: 'g' })).toEqual([]);
      const none = await catalog.getCatalog({ page: 1, genre: ['unknown'] });
      expect(none.meta).toMatchObject({ totalRecords: 0, totalPages: 0 });
    });

    it('reports the stored years and the last complete pass', async () => {
      const before = await catalog.getCatalog({ page: 1 });
      expect(before.meta.years).toEqual([1985, 2027]);
      expect(before.meta.stale).toBe(true);
      const fetchedAt = new Date(Date.now() - 60_000);
      await new ProjectionService(prisma).replaceSnapshot(
        CATALOG_PASS_KEY,
        'CATALOG',
        [],
        { ttlMinutes: 24 * 60, totalRecords: 43, fetchedAt },
      );
      const after = await catalog.getCatalog({ page: 1 });
      expect(after.meta).toMatchObject({
        fetchedAt: fetchedAt.toISOString(),
        stale: false,
      });
    });
  },
);
