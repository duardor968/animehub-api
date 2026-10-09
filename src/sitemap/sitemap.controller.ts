import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SitemapAnimeResponseDto } from '../common/contracts';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { SITEMAP_MAX_ANIME, SitemapService } from './sitemap.service';

// Public, slow-moving data: let the web's sitemap route and any CDN reuse it
// for an hour instead of the API-wide no-store policy.
export const SITEMAP_CACHE_CONTROL = 'public, max-age=3600';

@ApiTags('sitemap')
@Controller('sitemap')
export class SitemapController {
  constructor(private readonly sitemapService: SitemapService) {}

  @Get('anime')
  @ApiOperation({
    summary: 'Lista los anime disponibles para el sitemap',
    description: `Todos los anime que conoce la API y siguen disponibles en la fuente, ordenados por slug (máximo ${SITEMAP_MAX_ANIME.toLocaleString('es')}). Respuesta cacheable: Cache-Control "${SITEMAP_CACHE_CONTROL}".`,
  })
  @ApiOkResponse({
    type: SitemapAnimeResponseDto,
    headers: {
      'Cache-Control': {
        description: SITEMAP_CACHE_CONTROL,
        schema: { type: 'string' },
      },
    },
  })
  @ApiProblemResponses(429, 500)
  getAnime(@Res({ passthrough: true }) reply: FastifyReply) {
    // Runs after NoStoreInterceptor, so this overrides its default.
    reply.header('Cache-Control', SITEMAP_CACHE_CONTROL);
    return this.sitemapService.getAnime();
  }
}
