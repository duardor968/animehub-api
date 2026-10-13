import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ResolveDownloadsDto,
  ResolveDownloadsResponseDto,
} from './download.dto';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { DownloadResolverService } from './download-resolver.service';

// The Web resolves an episode whenever its copy menu opens, on hover, so
// browsing one series makes dozens of these calls a minute.
export const RESOLVE_RATE_LIMIT = 60;

@ApiTags('downloads')
@Controller('anime/:slug/downloads')
export class DownloadController {
  constructor(private readonly resolver: DownloadResolverService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @RouteConfig({
    rateLimit: { max: RESOLVE_RATE_LIMIT, timeWindow: '1 minute' },
  })
  @ApiOperation({ summary: 'Resuelve hasta cincuenta episodios por operación' })
  @ApiOkResponse({ type: ResolveDownloadsResponseDto })
  @ApiProblemResponses(400, 404, 429, 500, 503)
  resolve(@Param('slug') slug: string, @Body() body: ResolveDownloadsDto) {
    return this.resolver.resolve(slug, body);
  }
}
