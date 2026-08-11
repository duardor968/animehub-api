import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HomeResponseDto } from '../common/contracts';
import { HomeService } from './home.service';

@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  @Get()
  @ApiOperation({ summary: 'Devuelve portada, estrenos y añadidos recientes' })
  @ApiOkResponse({ type: HomeResponseDto })
  getHome() {
    return this.homeService.getHome();
  }
}
