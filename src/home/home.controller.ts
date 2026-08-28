import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HomeResponseDto } from '../common/contracts';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { HomeService } from './home.service';

@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  @Get()
  @ApiOperation({ summary: 'Devuelve portada, estrenos y añadidos recientes' })
  @ApiOkResponse({ type: HomeResponseDto })
  @ApiProblemResponses(429, 500, 503)
  getHome() {
    return this.homeService.getHome();
  }
}
