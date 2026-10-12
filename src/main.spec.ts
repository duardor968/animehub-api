import { vi } from 'vitest';

const { app, configureApp } = vi.hoisted(() => ({
  app: {
    get: vi.fn(() => ({
      get: vi.fn((key: string) => ({ PORT: 8000, HOST: '127.0.0.1' })[key]),
    })),
    enableShutdownHooks: vi.fn(),
    listen: vi.fn().mockResolvedValue(undefined),
  },
  configureApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@nestjs/core', () => ({
  NestFactory: { create: vi.fn().mockResolvedValue(app) },
}));
vi.mock('./app.module', () => ({ AppModule: class AppModule {} }));
vi.mock('./configure-app', () => ({ configureApp }));
vi.mock('./fastify-adapter', () => ({ createFastifyAdapter: vi.fn() }));

describe('API bootstrap', () => {
  it('enables graceful lifecycle hooks before accepting requests', async () => {
    await import('./main.js');
    await vi.waitFor(() => expect(app.listen).toHaveBeenCalled());
    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
    expect(app.enableShutdownHooks.mock.invocationCallOrder[0]).toBeLessThan(
      app.listen.mock.invocationCallOrder[0],
    );
    expect(app.listen).toHaveBeenCalledWith(8000, '127.0.0.1');
  });
});
