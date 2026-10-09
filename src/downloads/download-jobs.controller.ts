import {
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
  @ApiOkResponse({ type: DownloadJobReceiptResponseDto })
  @ApiProblemResponses(400, 404, 429, 500, 503)
  create(@Param('slug') slug: string, @Body() body: CreateDownloadJobDto) {
    return this.jobs.create(slug, body);
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

  private token(authorization?: string) {
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('A bearer capability is required.');
    }
    return token;
  }
}
