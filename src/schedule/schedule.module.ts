import { Module } from '@nestjs/common';
import { ProjectionModule } from '../projection/projection.module';
import { SourceModule } from '../source/source.module';
import { ScheduleRefreshScheduler } from './schedule-refresh.scheduler';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';

@Module({
  imports: [SourceModule, ProjectionModule],
  controllers: [ScheduleController],
  providers: [ScheduleService, ScheduleRefreshScheduler],
})
export class ScheduleModule {}
