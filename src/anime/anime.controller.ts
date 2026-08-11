import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AnimeResponseDto, EpisodePageResponseDto } from '../common/contracts';
import { AnimeService } from './anime.service';
import { EpisodeQueryDto } from './episode-query.dto';

@ApiTags('anime')
@Controller('anime')
export class AnimeController {
  constructor(private readonly animeService: AnimeService) {}

  @Get(':slug')
  @ApiOperation({ summary: 'Devuelve la ficha normalizada de un anime' })
  @ApiOkResponse({ type: AnimeResponseDto })
  getAnime(@Param('slug') slug: string) {
    return this.animeService.getAnime(slug);
  }

  @Get(':slug/episodes')
  @ApiOperation({ summary: 'Devuelve episodios en páginas de cincuenta' })
  @ApiOkResponse({ type: EpisodePageResponseDto })
  getEpisodes(@Param('slug') slug: string, @Query() query: EpisodeQueryDto) {
    return this.animeService.getEpisodes(slug, query.page ?? 1);
  }
}
