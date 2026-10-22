import { Module } from '@nestjs/common';
import { SourceModule } from '../source/source.module';
import { RelationDiscoveryScheduler } from './relation-discovery.scheduler';
import { ProjectionService } from './projection.service';

@Module({
  imports: [SourceModule],
  providers: [ProjectionService, RelationDiscoveryScheduler],
  exports: [ProjectionService],
})
export class ProjectionModule {}
