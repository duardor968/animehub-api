import { ConfigService } from '@nestjs/config';
import { HttpException, ValidationPipe } from '@nestjs/common';
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
  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'OPTIONS'],
    // Not CORS-safelisted: without this a browser cannot read when to retry
    // after a 429, or how much of the limit is left.
    exposedHeaders: [
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
  });
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
  await app.register(rateLimit, {
    max: Number(config.get<string | number>('RATE_LIMIT_MAX', 120)),
    timeWindow: '1 minute',
    // The plugin's default is a plain Error carrying statusCode 429, which the
    // Nest Fastify adapter does not map: it reached ProblemDetailsFilter as an
    // unknown error and went out as 500. Throw an HttpException instead; the
    // plugin has already set Retry-After and the X-RateLimit-* headers.
    errorResponseBuilder: (_request, context) =>
      new HttpException(
        {
          statusCode: context.statusCode,
          error: context.ban ? 'Forbidden' : 'Too Many Requests',
          message: `Rate limit exceeded, retry in ${context.after}.`,
        },
        context.statusCode,
      ),
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
