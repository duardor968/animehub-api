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
    description: `La fuente sirve páginas de ${ANIMEAV1_CATALOG_PAGE_SIZE} y como máximo ${ANIMEAV1_CATALOG_MAX_RECORDS} resultados (${ANIMEAV1_CATALOG_MAX_PAGES} páginas) por consulta. Cuando una consulta coincide con más títulos, la fuente trunca el conjunto: meta.totalRecords se queda en ${ANIMEAV1_CATALOG_MAX_RECORDS}, las páginas posteriores a la ${ANIMEAV1_CATALOG_MAX_PAGES} llegan vacías y meta.capped es true. Para alcanzar el resto hay que acotar la consulta (inicial, años, género, formato o estado).`,
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
  @ApiQuery({ name: 'status', required: false, enum: catalogStatusValues })
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
  @ApiOperation({ summary: 'Devuelve hasta ocho sugerencias de búsqueda' })
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
