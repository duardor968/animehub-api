import { Controller, Get, Query } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CatalogResponseDto, SuggestionResponseDto } from '../common/contracts';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import {
  ANIMEAV1_CATALOG_MAX_PAGES,
  ANIMEAV1_CATALOG_MAX_RECORDS,
  ANIMEAV1_CATALOG_PAGE_SIZE,
} from '../source/animeav1.constants';
import {
  catalogOrderValues,
  catalogStatusValues,
  CatalogQueryDto,
  SuggestionQueryDto,
} from './catalog-query.dto';
import { CatalogService } from './catalog.service';

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  @RouteConfig({ rateLimit: { max: 60, timeWindow: '1 minute' } })
  @ApiOperation({
    summary: 'Busca y filtra el catálogo paginado',
    description: `Sin search responde el catálogo guardado completo, que un pase diario mantiene al día con la fuente: totalRecords es exacto, capped es false y meta.fetchedAt es el último pase completo. Varios géneros devuelven las obras que los tienen todos. order=title ordena alfabéticamente palabra por palabra, sin contar los signos iniciales, los acentos ni las mayúsculas y con los números por su valor; letter es la primera letra o cifra del título, sin acentos (# para las que empiezan por cifra). Con search responde la fuente, que sirve páginas de ${ANIMEAV1_CATALOG_PAGE_SIZE} y como máximo ${ANIMEAV1_CATALOG_MAX_RECORDS} resultados (${ANIMEAV1_CATALOG_MAX_PAGES} páginas): con más coincidencias, meta.totalRecords se queda en ${ANIMEAV1_CATALOG_MAX_RECORDS}, las páginas posteriores a la ${ANIMEAV1_CATALOG_MAX_PAGES} llegan vacías y meta.capped es true.`,
  })
  @ApiQuery({
    name: 'page',
    required: false,
    schema: { type: 'integer', default: 1, minimum: 1, maximum: 500 },
  })
  @ApiQuery({ name: 'search', required: false, type: String, maxLength: 100 })
  @ApiQuery({ name: 'order', required: false, enum: catalogOrderValues })
  @ApiQuery({
    name: 'letter',
    required: false,
    type: String,
    minLength: 1,
    maxLength: 1,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: catalogStatusValues,
    description: 'proximamente returns both UPCOMING and PAUSED anime.',
  })
  @ApiQuery({
    name: 'genre',
    required: false,
    style: 'form',
    explode: true,
    schema: {
      type: 'array',
      maxItems: 20,
      uniqueItems: true,
      items: { type: 'string', maxLength: 80 },
    },
  })
  @ApiQuery({
    name: 'category',
    required: false,
    style: 'form',
    explode: true,
    schema: {
      type: 'array',
      maxItems: 20,
      uniqueItems: true,
      items: { type: 'string', maxLength: 80 },
    },
  })
  @ApiQuery({
    name: 'minYear',
    required: false,
    schema: { type: 'integer', minimum: 1900, maximum: 2200 },
  })
  @ApiQuery({
    name: 'maxYear',
    required: false,
    schema: { type: 'integer', minimum: 1900, maximum: 2200 },
  })
  @ApiOkResponse({ type: CatalogResponseDto })
  @ApiProblemResponses(400, 429, 500, 503)
  getCatalog(@Query() query: CatalogQueryDto) {
    return this.catalogService.getCatalog(query);
  }

  @Get('suggestions')
  @RouteConfig({ rateLimit: { max: 120, timeWindow: '1 minute' } })
  @ApiOperation({
    summary: 'Devuelve hasta ocho sugerencias de búsqueda',
    description: 'Las coincidencias más populares primero.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    type: String,
    minLength: 2,
    maxLength: 100,
  })
  @ApiOkResponse({ type: SuggestionResponseDto })
  @ApiProblemResponses(400, 429, 500)
  getSuggestions(@Query() query: SuggestionQueryDto) {
    return this.catalogService.getSuggestions(query.q);
  }
}
