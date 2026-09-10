import { FastifyAdapter } from '@nestjs/platform-fastify';
import {
  createFastifyAdapter,
  MAX_ROUTE_PARAM_LENGTH,
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
