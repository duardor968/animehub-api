import { Controller, Get, Query } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CatalogResponseDto, SuggestionResponseDto } from '../common/contracts';
import { CatalogQueryDto, SuggestionQueryDto } from './catalog-query.dto';
import { CatalogService } from './catalog.service';

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  @RouteConfig({ rateLimit: { max: 60, timeWindow: '1 minute' } })
  @ApiOperation({ summary: 'Busca y filtra el catálogo paginado' })
  @ApiOkResponse({ type: CatalogResponseDto })
  getCatalog(@Query() query: CatalogQueryDto) {
    return this.catalogService.getCatalog(query);
  }

  @Get('suggestions')
  @RouteConfig({ rateLimit: { max: 120, timeWindow: '1 minute' } })
  @ApiOperation({ summary: 'Devuelve hasta ocho sugerencias de búsqueda' })
  @ApiOkResponse({ type: SuggestionResponseDto })
  getSuggestions(@Query() query: SuggestionQueryDto) {
    return this.catalogService.getSuggestions(query.q);
  }
}
