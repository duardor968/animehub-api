import { Module } from '@nestjs/common';
import { SourceModule } from '../source/source.module';
import { DetailRefreshScheduler } from './detail-refresh.scheduler';
import { ProjectionService } from './projection.service';

@Module({
  imports: [SourceModule],
  providers: [ProjectionService, DetailRefreshScheduler],
  exports: [ProjectionService],
})
export class ProjectionModule {}
