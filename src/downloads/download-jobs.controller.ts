import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  AllDownloadJobRequestDto,
  CreateDownloadJobDto,
  DownloadJobReceiptResponseDto,
  DownloadJobResponseDto,
  EpisodesDownloadJobRequestDto,
  RangeDownloadJobRequestDto,
} from './download.dto';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { DownloadJobsService } from './download-jobs.service';

// Long enough for a random key (a UUID is 36), so that knowing someone's key,
// which is what replays a job, is as unlikely as guessing its token.
const IDEMPOTENCY_KEY_MIN_LENGTH = 16;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

@ApiTags('download jobs')
@Controller()
export class DownloadJobsController {
  constructor(private readonly jobs: DownloadJobsService) {}

  @Post('anime/:slug/download-jobs')
  @RouteConfig({ rateLimit: { max: 5, timeWindow: '1 minute' } })
  @ApiOperation({
    summary: 'Crea un trabajo durable para una serie, un rango o una selección',
    description:
      'scope ALL resuelve todos los episodios; RANGE, los episodios con número entre from y to (ambos obligatorios, from ≤ to); EPISODES, exactamente los números de episodeNumbers (los que el anime no tiene se omiten y se devuelven en missingEpisodeNumbers). Responde 400 si ningún episodio coincide.',
  })
  @ApiExtraModels(
    AllDownloadJobRequestDto,
    RangeDownloadJobRequestDto,
    EpisodesDownloadJobRequestDto,
  )
  @ApiBody({
    required: true,
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AllDownloadJobRequestDto) },
        { $ref: getSchemaPath(RangeDownloadJobRequestDto) },
        { $ref: getSchemaPath(EpisodesDownloadJobRequestDto) },
      ],
      discriminator: {
        propertyName: 'scope',
        mapping: {
          ALL: getSchemaPath(AllDownloadJobRequestDto),
          RANGE: getSchemaPath(RangeDownloadJobRequestDto),
          EPISODES: getSchemaPath(EpisodesDownloadJobRequestDto),
        },
      },
    },
  })
  @ApiHeader({
    name: 'idempotency-key',
    required: false,
    description:
      'Clave única por intento del usuario (p. ej. un UUID v4), repetida en cada reintento de esa misma solicitud. Si la clave ya creó un trabajo de este anime con el mismo cuerpo y el trabajo no ha expirado, se devuelve ese trabajo con un accessToken nuevo en lugar de crear otro; los tokens anteriores siguen valiendo. Con otro cuerpo responde 422; tras 10 repeticiones, 409.',
    schema: {
      type: 'string',
      minLength: IDEMPOTENCY_KEY_MIN_LENGTH,
      maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
      pattern: IDEMPOTENCY_KEY_PATTERN.source,
    },
  })
  @ApiOkResponse({ type: DownloadJobReceiptResponseDto })
  @ApiProblemResponses(400, 404, 409, 422, 429, 500, 503)
  create(
    @Param('slug') slug: string,
    @Body() body: CreateDownloadJobDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.jobs.create(slug, body, this.idempotencyKey(idempotencyKey));
  }

  @Get('download-jobs/:id')
  @RouteConfig({ rateLimit: { max: 120, timeWindow: '1 minute' } })
  @ApiBearerAuth('jobCapability')
  @ApiOperation({
    summary: 'Consulta progreso y resultados mediante capacidad',
  })
  @ApiOkResponse({ type: DownloadJobResponseDto })
  @ApiProblemResponses(401, 429, 500)
  get(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.jobs.get(id, this.token(authorization));
  }

  @Post('download-jobs/:id/retry')
  @RouteConfig({ rateLimit: { max: 10, timeWindow: '1 minute' } })
  @ApiBearerAuth('jobCapability')
  @ApiOperation({
    summary: 'Reintenta únicamente episodios fallidos',
    description:
      'Solo para trabajos terminados en PARTIAL o FAILED. Responde 400 si el trabajo sigue en curso, fue cancelado o no tiene episodios fallidos.',
  })
  @ApiOkResponse({ type: DownloadJobResponseDto })
  @ApiProblemResponses(400, 401, 429, 500)
  retry(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.jobs.retry(id, this.token(authorization));
  }

  @Post('download-jobs/:id/cancel')
  @RouteConfig({ rateLimit: { max: 20, timeWindow: '1 minute' } })
  @ApiBearerAuth('jobCapability')
  @ApiOperation({
    summary: 'Cancela los ítems pendientes del trabajo',
    description:
      'Un trabajo QUEUED o RUNNING pasa a CANCELLED junto con los episodios aún sin resolver; los ya resueltos se conservan. Si el trabajo ya había terminado (COMPLETED, PARTIAL o FAILED), no se modifica y se devuelve su estado final: comprueba status para saber si la cancelación llegó a tiempo. Repetirla sobre un trabajo cancelado no cambia nada.',
  })
  @ApiOkResponse({ type: DownloadJobResponseDto })
  @ApiProblemResponses(401, 429, 500)
  cancel(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.jobs.cancel(id, this.token(authorization));
  }

  private idempotencyKey(header?: string) {
    if (header === undefined) return undefined;
    // Accept the structured-field form ("...") of the IETF draft as well.
    const key = header.trim().replace(/^"(.*)"$/, '$1');
    if (
      key.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
      key.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
      !IDEMPOTENCY_KEY_PATTERN.test(key)
    ) {
      throw new BadRequestException(
        `Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN_LENGTH} to ${IDEMPOTENCY_KEY_MAX_LENGTH} letters, digits or "_.:-", such as a UUID.`,
      );
    }
    return key;
  }

  private token(authorization?: string) {
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('A bearer capability is required.');
    }
    return token;
  }
}
