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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  CreateDownloadJobDto,
  DownloadJobReceiptResponseDto,
  DownloadJobResponseDto,
} from './download.dto';
import { DownloadJobsService } from './download-jobs.service';

@ApiTags('download jobs')
@Controller()
export class DownloadJobsController {
  constructor(private readonly jobs: DownloadJobsService) {}

  @Post('anime/:slug/download-jobs')
  @RouteConfig({ rateLimit: { max: 5, timeWindow: '1 minute' } })
  @ApiOperation({ summary: 'Crea un trabajo durable para una serie o rango' })
  @ApiOkResponse({ type: DownloadJobReceiptResponseDto })
  create(@Param('slug') slug: string, @Body() body: CreateDownloadJobDto) {
    return this.jobs.create(slug, body);
  }

  @Get('download-jobs/:id')
  @RouteConfig({ rateLimit: { max: 120, timeWindow: '1 minute' } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Consulta progreso y resultados mediante capacidad',
  })
  @ApiOkResponse({ type: DownloadJobResponseDto })
  get(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.jobs.get(id, this.token(authorization));
  }

  @Post('download-jobs/:id/retry')
  @RouteConfig({ rateLimit: { max: 10, timeWindow: '1 minute' } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reintenta únicamente episodios fallidos' })
  @ApiOkResponse({ type: DownloadJobResponseDto })
  retry(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.jobs.retry(id, this.token(authorization));
  }

  @Post('download-jobs/:id/cancel')
  @RouteConfig({ rateLimit: { max: 20, timeWindow: '1 minute' } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancela los ítems pendientes del trabajo' })
  @ApiOkResponse({ type: DownloadJobResponseDto })
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
