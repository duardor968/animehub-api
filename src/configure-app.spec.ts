import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication, RouteConfig } from '@nestjs/platform-fastify';
import { configureApp } from './configure-app';
import { createFastifyAdapter } from './fastify-adapter';
import {
  AnimeAv1NotFoundError,
  AnimeAv1UnavailableError,
} from './source/animeav1.service';

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
  controllers: [ProbeController],
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
});
