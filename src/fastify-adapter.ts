import { FastifyAdapter } from '@nestjs/platform-fastify';

// Source slugs are full romanized titles and can exceed Fastify's 100-character
// default. Keep a finite bound, shared by runtime, OpenAPI generation and tests.
export const MAX_ROUTE_PARAM_LENGTH = 1024;

export function createFastifyAdapter(logging = false): FastifyAdapter {
  return new FastifyAdapter({
    routerOptions: { maxParamLength: MAX_ROUTE_PARAM_LENGTH },
    logger: logging
      ? {
          level: process.env.LOG_LEVEL ?? 'info',
          redact: {
            paths: [
              'req.headers.authorization',
              'req.body.password',
              'res.headers.authorization',
            ],
            censor: '[Redacted]',
          },
        }
      : false,
  });
}
