import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AnimeResponseDto, EpisodePageResponseDto } from '../common/contracts';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { AnimeService } from './anime.service';
import { EpisodeQueryDto } from './episode-query.dto';

@ApiTags('anime')
@Controller('anime')
export class AnimeController {
  constructor(private readonly animeService: AnimeService) {}

  @Get(':slug')
  @ApiOperation({ summary: 'Devuelve la ficha normalizada de un anime' })
  @ApiOkResponse({ type: AnimeResponseDto })
  @ApiProblemResponses(404, 429, 500, 503)
  getAnime(@Param('slug') slug: string) {
    return this.animeService.getAnime(slug);
  }

  @Get(':slug/episodes')
  @ApiOperation({ summary: 'Devuelve episodios en páginas de cincuenta' })
  @ApiQuery({
    name: 'page',
    required: false,
    schema: { type: 'integer', default: 1, minimum: 1, maximum: 1000 },
  })
  @ApiOkResponse({ type: EpisodePageResponseDto })
  @ApiProblemResponses(400, 404, 429, 500, 503)
  getEpisodes(@Param('slug') slug: string, @Query() query: EpisodeQueryDto) {
    return this.animeService.getEpisodes(slug, query.page ?? 1);
  }
}
