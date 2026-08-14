import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';
import { PrismaService } from './../src/prisma/prisma.service';
import { AnimeAv1Service } from './../src/source/animeav1.service';

const sourceAnime = {
  id: 'fixture-1',
  slug: 'fixture-anime',
  title: 'Fixture Anime',
  synopsis: 'Fixture synopsis',
  posterUrl: 'https://cdn.animeav1.com/covers/fixture-1.jpg',
  backdropUrl: 'https://cdn.animeav1.com/backdrops/fixture-1.jpg',
  category: { id: 'tv', name: 'TV Anime', slug: 'tv-anime' },
  genres: [],
  status: 'AIRING' as const,
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  mature: false,
};

const sourceMock = {
  getHome: jest.fn().mockResolvedValue({
    featured: [sourceAnime],
    recentEpisodes: [
      {
        anime: sourceAnime,
        episode: {
          id: 'fixture-episode-1',
          number: 1,
          title: null,
          sourcePath: '/media/fixture-anime/1',
          publishedAt: new Date('2026-08-10T12:00:00.000Z'),
        },
      },
    ],
    recentAnime: [sourceAnime],
  }),
  getAnime: jest.fn().mockResolvedValue({
    ...sourceAnime,
    alternativeTitle: 'Fixture Alternative',
    trailerUrl: 'https://www.youtube-nocookie.com/watch?v=fixture',
    endDate: null,
    nextEpisodeAt: null,
    episodeCount: 12,
    score: 8.1,
    votes: 1200,
    episodes: [],
    relations: [],
  }),
};

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;
  type TestServer = Parameters<typeof request>[0];

  beforeEach(async () => {
    process.env.JOBS_ENABLED = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AnimeAv1Service)
      .useValue(sourceMock)
      .compile();

    await moduleFixture.get(PrismaService).snapshot.deleteMany({
      where: { key: { startsWith: 'home:' } },
    });

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  it('/api/v1/health/live (GET)', () => {
    return request(app.getHttpServer() as TestServer)
      .get('/api/v1/health/live')
      .expect(200)
      .expect({
        service: 'animehub-api',
        status: 'live',
        version: '0.1.0',
      });
  });

  it('/api/v1/health/ready (GET)', () => {
    return request(app.getHttpServer() as TestServer)
      .get('/api/v1/health/ready')
      .expect(200)
      .expect({
        checks: { database: 'up' },
        status: 'ready',
      });
  });

  it('/openapi.json (GET)', () => {
    return request(app.getHttpServer() as TestServer)
      .get('/openapi.json')
      .expect(200)
      .expect(({ body }: { body: { info?: { title?: string } } }) => {
        expect(body.info?.title).toBe('AnimeHub API');
      });
  });

  it('/api/v1/home (GET) projects a validated source fixture', async () => {
    await request(app.getHttpServer() as TestServer)
      .get('/api/v1/home')
      .expect(200)
      .expect(({ body }: { body: { data?: { featured?: unknown[] } } }) => {
        expect(body.data?.featured).toEqual([
          expect.objectContaining({
            slug: 'fixture-anime',
            episodeCount: 12,
            trailerUrl: 'https://www.youtube-nocookie.com/watch?v=fixture',
            genres: [],
          }),
        ]);
      });
  });

  it('returns Problem Details for invalid input', () => {
    return request(app.getHttpServer() as TestServer)
      .get('/api/v1/catalog?page=0')
      .expect('content-type', /application\/problem\+json/)
      .expect(400)
      .expect(({ body }: { body: { status?: number; title?: string } }) => {
        expect(body).toEqual(
          expect.objectContaining({ status: 400, title: 'Bad Request' }),
        );
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
