import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8000),
  DATABASE_URL: z.url(),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  ANIMEAV1_BASE_URL: z.url().default('https://animeav1.com'),
  SOURCE_USER_AGENT: z
    .string()
    .min(10)
    .default('AnimeHub/1.0 (+https://github.com/duardor968/animehub-web)'),
  JOBS_ENABLED: z.enum(['true', 'false']).default('true'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export function validateEnvironment(environment: Record<string, unknown>) {
  return environmentSchema.parse(environment);
}
