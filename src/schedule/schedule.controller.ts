import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ScheduleResponseDto } from '../common/contracts';
import { ScheduleService } from './schedule.service';

@ApiTags('schedule')
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Get()
  @ApiOperation({ summary: 'Devuelve el horario semanal estimado' })
  @ApiOkResponse({ type: ScheduleResponseDto })
  getSchedule() {
    return this.scheduleService.getSchedule();
  }
}
