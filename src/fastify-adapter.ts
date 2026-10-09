import { FastifyAdapter } from '@nestjs/platform-fastify';

// Source slugs are full romanized titles and can exceed Fastify's 100-character
// default. Keep a finite bound, shared by runtime, OpenAPI generation and tests.
export const MAX_ROUTE_PARAM_LENGTH = 1024;

/**
 * Parses TRUST_PROXY for Fastify's `trustProxy`, which decides whether
 * `request.ip` (the rate-limit key) comes from X-Forwarded-For. Behind a reverse
 * proxy, or for SSR requests relayed by the web server, leaving it off makes
 * every client share one rate-limit bucket. Only enable it for hops that
 * overwrite the header, otherwise clients can spoof their address.
 * Unset/"false" → off; "true" → trust every hop; "<n>" → trust n hops;
 * anything else → comma-separated trusted addresses/CIDRs.
 */
export function parseTrustProxy(
  value: string | undefined,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  const normalized = value?.trim() ?? '';
  if (normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  if (/^\d+$/.test(normalized)) {
    const hops = Number(normalized);
    return (_address, hop) => hop < hops;
  }
  return normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function createFastifyAdapter(logging = false): FastifyAdapter {
  return new FastifyAdapter({
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
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
