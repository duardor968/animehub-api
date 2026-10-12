import { z } from 'zod';

const optionalUrl = z.union([z.literal(''), z.url()]).optional();

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  DATABASE_URL: z.url(),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  ANIMEAV1_BASE_URL: z.url().default('https://animeav1.com'),
  SOURCE_USER_AGENT: z
    .string()
    .min(10)
    .default('AnimeHub/1.0 (+https://github.com/duardor968/animehub-api)'),
  JOBS_ENABLED: z.enum(['true', 'false']).default('true'),
  // Read directly by createFastifyAdapter (before Nest config exists).
  TRUST_PROXY: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  // S3-compatible storage of the WebP copies of source images. Unless all six
  // are set, the API serves the source image URLs.
  MEDIA_S3_ENDPOINT: optionalUrl,
  MEDIA_S3_REGION: z.string().optional(),
  MEDIA_S3_ACCESS_KEY_ID: z.string().optional(),
  MEDIA_S3_SECRET_ACCESS_KEY: z.string().optional(),
  MEDIA_S3_BUCKET: z.string().optional(),
  MEDIA_PUBLIC_URL: optionalUrl,
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export function validateEnvironment(environment: Record<string, unknown>) {
  return environmentSchema.parse(environment);
}
