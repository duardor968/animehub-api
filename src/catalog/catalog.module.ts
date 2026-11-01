import { Module } from '@nestjs/common';
import { ProjectionModule } from '../projection/projection.module';
import { SourceModule } from '../source/source.module';
import { CatalogController } from './catalog.controller';
import { CatalogPassScheduler } from './catalog-pass.scheduler';
import { CatalogService } from './catalog.service';

@Module({
  imports: [SourceModule, ProjectionModule],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogPassScheduler],
})
export class CatalogModule {}
