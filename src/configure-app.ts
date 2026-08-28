import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { NoStoreInterceptor } from './common/no-store.interceptor';
import { ProblemDetailsFilter } from './common/problem-details.filter';

export async function configureApp(app: NestFastifyApplication) {
  const config = app.get(ConfigService);
  const origins = config
    .get<string>('CORS_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: origins, methods: ['GET', 'POST', 'OPTIONS'] });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
  // Dynamic projections and capability-protected download jobs must never be
  // retained by a browser, reverse proxy or shared cache. Freshness is governed
  // exclusively by the API's durable snapshots.
  app.useGlobalInterceptors(new NoStoreInterceptor());
  await app.register(helmet as never, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit as never, {
    max: 120,
    timeWindow: '1 minute',
  });

  const document = createOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: '/openapi.json',
  });
  return document;
}

export function createOpenApiDocument(
  app: NestFastifyApplication,
): OpenAPIObject {
  const openApiConfig = new DocumentBuilder()
    .setTitle('AnimeHub API')
    .setDescription(
      'Contrato público REST compartido por AnimeHub Web y Desktop.',
    )
    .setVersion('1.0.0')
    .addServer('https://animehub-api.duardo.dev', 'Producción')
    .addServer('http://localhost:8000', 'Desarrollo local')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'opaque capability',
        description:
          'Capacidad opaca y temporal devuelta al crear un trabajo de descarga; no es un JWT.',
      },
      'jobCapability',
    )
    .build();
  return SwaggerModule.createDocument(app, openApiConfig);
}
