import { MessageEvent, Module, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EMPTY, ignoreElements, interval, tap } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureApp } from '../configure-app';
import { createFastifyAdapter } from '../fastify-adapter';
import { HEARTBEAT_MS, RemoteEvents } from './remote-events';
import { RemoteController } from './remote.controller';
import { RemoteService } from './remote.service';

describe('RemoteEvents', () => {
  afterEach(() => vi.useRealTimers());
  it('delivers only the audience and id it names, plus a heartbeat', () => {
    vi.useFakeTimers();
    const events = new RemoteEvents();
    const got: MessageEvent[] = [];
    const stream = events.stream('device', 'pc').subscribe((e) => got.push(e));
    events.session('pc', 'devices');
    events.device('other', 'inbox');
    events.device('pc', 'links', 'inbox', 'links');
    expect(got.map((e) => e.type)).toEqual(['links', 'inbox']);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(got.at(-1)).toEqual({ comment: '' });
    stream.unsubscribe();
  });
  it('knows a PC is offline as soon as its last channel closes, and says so', () => {
    const events = new RemoteEvents();
    const changed = vi.fn();
    expect(events.presence('pc')).toBeNull();
    const first = events.deviceStream('pc', EMPTY, changed).subscribe();
    const second = events.deviceStream('pc', EMPTY, changed).subscribe();
    expect(events.presence('pc')).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    first.unsubscribe();
    expect(events.presence('pc')).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    second.unsubscribe();
    expect(events.presence('pc')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
    // Shutting down closes channels, not PCs: nothing to announce.
    events.deviceStream('pc', EMPTY, changed).subscribe();
    expect(events.presence('pc')).toBe(true);
    events.onModuleDestroy();
    expect(changed).toHaveBeenCalledTimes(4);
  });
  it('ends every stream, and what runs alongside it, on shutdown', () => {
    vi.useFakeTimers();
    const events = new RemoteEvents();
    let completed = false;
    let ticks = 0;
    const alongside = interval(1000).pipe(
      tap(() => ticks++),
      ignoreElements(),
    );
    events
      .stream('session', 's', alongside)
      .subscribe({ complete: () => (completed = true) });
    vi.advanceTimersByTime(1000);
    events.onModuleDestroy();
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(completed).toBe(true);
    expect(ticks).toBe(1);
  });
});

const events = new RemoteEvents();
const deviceEvents = vi.fn((auth?: string) => {
  if (auth !== `Bearer ${'a'.repeat(43)}`) throw new UnauthorizedException();
  return Promise.resolve(events.stream('device', 'pc'));
});
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
  controllers: [RemoteController],
  providers: [
    { provide: RemoteService, useValue: { deviceEvents } },
    { provide: RemoteEvents, useValue: events },
  ],
})
class StreamTestModule {}

describe('Remote live channel over HTTP', () => {
  it('refuses a missing credential before streaming, streams with CORS and no transform, and ends on shutdown', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      StreamTestModule,
      createFastifyAdapter(),
      { logger: false },
    );
    await configureApp(app);
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/api/v1/remote/devices/me/events`;
    try {
      const refused = await fetch(url);
      expect(refused.status).toBe(401);
      expect(refused.headers.get('content-type')).not.toContain(
        'text/event-stream',
      );

      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${'a'.repeat(43)}`,
          origin: 'http://localhost:3000',
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toContain('no-transform');
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:3000',
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      events.device('pc', 'inbox');
      while (!text.includes('event: inbox')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      expect(text).toContain('event: inbox\n');
      const ended = (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })();
      await app.close();
      expect(await ended).toBe(true);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
