import { Module, NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureApp } from '../configure-app';
import { createFastifyAdapter } from '../fastify-adapter';
import { RemoteController } from './remote.controller';
import { RemoteService } from './remote.service';
const pair = vi.fn(() => {
  throw new NotFoundException();
});
const create = vi.fn();
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
  controllers: [RemoteController],
  providers: [{ provide: RemoteService, useValue: { pair, create } }],
})
class RemoteTestModule {}
describe('Remote HTTP security boundary', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      RemoteTestModule,
      createFastifyAdapter(),
      { logger: false },
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());
  it('limits six-digit code guesses to five per IP per ten minutes', async () => {
    for (let n = 0; n < 5; n++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/remote/links',
            payload: { code: '123456' },
          })
        ).statusCode,
      ).toBe(404);
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/remote/links',
      payload: { code: '123456' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(pair).toHaveBeenCalledTimes(5);
  });
  it('refuses local paths and provider settings before invoking the service', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/remote/requests',
      payload: {
        deviceId: '7885d03f-f1cd-469d-bd65-591c53186cb3',
        animeSlug: 'anime-one',
        episodeNumbers: [1],
        profileId: 'default',
        profileRevision: 1,
        engine: 'direct',
        path: 'C:\\Anime',
      },
    });
    expect(result.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('permits cross-origin profile PUT and link DELETE preflights for configured origin', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const result = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/remote/devices',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(result.statusCode).toBe(204);
      expect(result.headers['access-control-allow-methods']).toContain(method);
    }
  });
});
