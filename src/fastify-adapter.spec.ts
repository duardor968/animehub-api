import { FastifyAdapter } from '@nestjs/platform-fastify';
import { vi } from 'vitest';
import {
  createFastifyAdapter,
  MAX_ROUTE_PARAM_LENGTH,
  parseTrustProxy,
} from './fastify-adapter';

const reportedSlug =
  'tenkou-saki-no-seiso-karen-na-bishoujo-ga-mukashi-danshi-to-omotte-issho-ni-asonda-osananajimi-datta-ken';

describe('routing source slugs', () => {
  it('reproduces the production rejection with the default router', async () => {
    const adapter = new FastifyAdapter();
    const server = adapter.getInstance();
    server.get('/api/v1/anime/:slug', () => ({ reached: true }));
    try {
      const response = await server.inject(`/api/v1/anime/${reportedSlug}`);
      expect(reportedSlug.length).toBeGreaterThan(100);
      expect(response.statusCode).toBe(414);
      expect(response.json<{ code: string }>().code).toBe(
        'FST_ERR_MAX_PARAM_LENGTH',
      );
    } finally {
      await adapter.close();
    }
  });

  it.each([
    ['GET', ''],
    ['GET', '/episodes'],
    ['POST', '/downloads/resolve'],
    ['POST', '/download-jobs'],
  ] as const)(
    'routes %s anime/:slug%s without truncation',
    async (method, suffix) => {
      const adapter = createFastifyAdapter();
      const server = adapter.getInstance();
      server.route<{ Params: { slug: string } }>({
        method,
        url: `/api/v1/anime/:slug${suffix}`,
        handler: (request) => ({ slug: request.params.slug }),
      });
      try {
        for (const slug of [
          'one-piece',
          'a'.repeat(100),
          'a'.repeat(101),
          reportedSlug,
          'a'.repeat(MAX_ROUTE_PARAM_LENGTH),
        ]) {
          const response = await server.inject({
            method,
            url: `/api/v1/anime/${slug}${suffix}`,
          });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ slug });
        }
        const response = await server.inject({
          method,
          url: `/api/v1/anime/${'a'.repeat(MAX_ROUTE_PARAM_LENGTH + 1)}${suffix}`,
        });
        expect(response.statusCode).toBe(414);
        expect(response.json<{ code: string }>().code).toBe(
          'FST_ERR_MAX_PARAM_LENGTH',
        );
      } finally {
        await adapter.close();
      }
    },
  );
});

describe('TRUST_PROXY', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['true', true],
    ['10.0.0.0/8, 127.0.0.1', ['10.0.0.0/8', '127.0.0.1']],
  ] as const)('parses %j', (value, expected) => {
    expect(parseTrustProxy(value)).toEqual(expected);
  });

  it('trusts a fixed number of hops', () => {
    const trust = parseTrustProxy('1');
    expect(typeof trust).toBe('function');
    if (typeof trust !== 'function') return;
    expect(trust('10.0.0.1', 0)).toBe(true);
    expect(trust('10.0.0.2', 1)).toBe(false);
  });

  it.each([
    [undefined, '127.0.0.1'],
    ['127.0.0.1', '203.0.113.7'],
    ['1', '203.0.113.7'],
  ])(
    'keys clients by their own address (TRUST_PROXY=%s)',
    async (trustProxy, expectedIp) => {
      if (trustProxy) vi.stubEnv('TRUST_PROXY', trustProxy);
      const adapter = createFastifyAdapter();
      const server = adapter.getInstance();
      server.get('/ip', (request) => ({ ip: request.ip }));
      try {
        const response = await server.inject({
          url: '/ip',
          headers: { 'x-forwarded-for': '203.0.113.7' },
        });
        expect(response.json()).toEqual({ ip: expectedIp });
      } finally {
        await adapter.close();
      }
    },
  );
});
