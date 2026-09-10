import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { createFastifyAdapter } from './fastify-adapter';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter(true),
  );
  const config = app.get(ConfigService);
  await configureApp(app);

  const port = config.get<number>('PORT', 8000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
