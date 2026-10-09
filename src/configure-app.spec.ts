import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication, RouteConfig } from '@nestjs/platform-fastify';
import { API_CACHE_CONTROL } from './common/no-store.interceptor';
import { configureApp } from './configure-app';
import { createFastifyAdapter } from './fastify-adapter';
import {
  AnimeAv1NotFoundError,
  AnimeAv1UnavailableError,
} from './source/animeav1.service';
import {
  SITEMAP_CACHE_CONTROL,
  SitemapController,
} from './sitemap/sitemap.controller';
import { SitemapService } from './sitemap/sitemap.service';

@Controller('probe')
class ProbeController {
  @Get('limited')
  @RouteConfig({ rateLimit: { max: 1, timeWindow: '1 minute' } })
  limited() {
    return { ok: true };
  }

  @Get('source-down')
  sourceDown() {
    throw new AnimeAv1UnavailableError('Source status 502');
  }

  @Get('source-missing')
  sourceMissing() {
    throw new AnimeAv1NotFoundError('/media/zz');
  }

  @Get('bug')
  bug() {
    throw new TypeError('Cannot read properties of undefined');
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
  controllers: [ProbeController, SitemapController],
  providers: [
    {
      provide: SitemapService,
      useValue: {
        getAnime: () =>
          Promise.resolve({
            data: [
              { slug: 'one-piece', updatedAt: '2026-10-01T00:00:00.000Z' },
            ],
          }),
      },
    },
  ],
})
class ProbeModule {}

describe('HTTP error mapping through Nest + Fastify', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      createFastifyAdapter(),
      { logger: false },
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  it('answers our own rate limit with 429 Problem Details and Retry-After', async () => {
    const first = await app.inject({ url: '/api/v1/probe/limited' });
    const limited = await app.inject({ url: '/api/v1/probe/limited' });

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const problem = limited.json<{
      status: number;
      title: string;
      detail: string;
    }>();
    expect(problem).toMatchObject({ status: 429, title: 'Too Many Requests' });
    expect(problem.detail).toContain('Rate limit exceeded');
  });

  it('maps upstream failures to 503 and source not-found to 404', async () => {
    const down = await app.inject({ url: '/api/v1/probe/source-down' });
    const missing = await app.inject({ url: '/api/v1/probe/source-missing' });

    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({
      status: 503,
      detail: 'AnimeAV1 is temporarily unavailable.',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('keeps 500 for genuine bugs without leaking their message', async () => {
    const response = await app.inject({ url: '/api/v1/probe/bug' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      detail: 'The server could not complete the request.',
    });
  });

  it('answers malformed JSON with 400 instead of 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"scope":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
  });

  it('lets the sitemap listing be cached while other routes stay no-store', async () => {
    const sitemap = await app.inject({ url: '/api/v1/sitemap/anime' });
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/probe/echo',
      payload: {},
    });

    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.headers['cache-control']).toBe(SITEMAP_CACHE_CONTROL);
    expect(sitemap.json()).toEqual({
      data: [{ slug: 'one-piece', updatedAt: '2026-10-01T00:00:00.000Z' }],
    });
    expect(other.headers['cache-control']).toBe(API_CACHE_CONTROL);
  });
});

describe('rate limit keys behind trusted proxies', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // app.inject() connects from 127.0.0.1: here, the web server.
    vi.stubEnv('TRUST_PROXY', '127.0.0.1');
    app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      createFastifyAdapter(),
      { logger: false },
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  const fromVisitor = (visitor: string) =>
    app.inject({
      url: '/api/v1/probe/limited',
      headers: { 'x-forwarded-for': visitor },
    });

  it('gives each visitor its own bucket for SSR requests relayed by the web', async () => {
    const first = await fromVisitor('203.0.113.7');
    const again = await fromVisitor('203.0.113.7');
    const other = await fromVisitor('198.51.100.4');

    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(429);
    expect(other.statusCode).toBe(200);
  });

  it('does not let an untrusted peer pick its bucket with X-Forwarded-For', async () => {
    const statuses = [];
    for (const visitor of ['192.0.2.1', '192.0.2.2']) {
      const response = await app.inject({
        url: '/api/v1/probe/limited',
        remoteAddress: '203.0.113.50',
        headers: { 'x-forwarded-for': visitor },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([200, 429]);
  });
});
