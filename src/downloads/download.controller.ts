import { Body, Controller, Param, Post } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ResolveDownloadsDto,
  ResolveDownloadsResponseDto,
} from './download.dto';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { DownloadResolverService } from './download-resolver.service';

@ApiTags('downloads')
@Controller('anime/:slug/downloads')
export class DownloadController {
  constructor(private readonly resolver: DownloadResolverService) {}

  @Post('resolve')
  @RouteConfig({ rateLimit: { max: 20, timeWindow: '1 minute' } })
  @ApiOperation({ summary: 'Resuelve hasta cincuenta episodios por operación' })
  @ApiOkResponse({ type: ResolveDownloadsResponseDto })
  @ApiProblemResponses(400, 404, 429, 500, 503)
  resolve(@Param('slug') slug: string, @Body() body: ResolveDownloadsDto) {
    return this.resolver.resolve(slug, body);
  }
}
