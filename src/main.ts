import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: {
          paths: [
            'req.headers.authorization',
            'req.body.password',
            'res.headers.authorization',
          ],
          censor: '[Redacted]',
        },
      },
    }),
  );
  const config = app.get(ConfigService);
  await configureApp(app);

  const port = config.get<number>('PORT', 8000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
