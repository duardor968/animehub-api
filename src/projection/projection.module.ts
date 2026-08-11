import { Module } from '@nestjs/common';
import { ProjectionService } from './projection.service';

@Module({
  providers: [ProjectionService],
  exports: [ProjectionService],
})
export class ProjectionModule {}
