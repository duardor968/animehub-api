import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ScheduleResponseDto } from '../common/contracts';
import { ApiProblemResponses } from '../common/openapi-problem-responses';
import { ScheduleService } from './schedule.service';

@ApiTags('schedule')
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Get()
  @ApiOperation({ summary: 'Devuelve el horario semanal estimado' })
  @ApiOkResponse({ type: ScheduleResponseDto })
  @ApiProblemResponses(429, 500, 503)
  getSchedule() {
    return this.scheduleService.getSchedule();
  }
}
