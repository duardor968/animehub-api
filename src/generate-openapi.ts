import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function generate() {
  process.env.JOBS_ENABLED = 'false';
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  const document = await configureApp(app);
  await writeFile(
    resolve(process.cwd(), 'openapi.json'),
    `${JSON.stringify(document, null, 2)}\n`,
    'utf8',
  );
  await app.close();
}

void generate();
