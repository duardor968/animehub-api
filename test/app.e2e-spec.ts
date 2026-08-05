import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;
  type TestServer = Parameters<typeof request>[0];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
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

  it('/docs-json (GET)', () => {
    return request(app.getHttpServer() as TestServer)
      .get('/docs-json')
      .expect(200)
      .expect(({ body }: { body: { info?: { title?: string } } }) => {
        expect(body.info?.title).toBe('AnimeHub API');
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
