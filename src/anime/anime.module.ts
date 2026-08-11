import { Module } from '@nestjs/common';
import { ProjectionModule } from '../projection/projection.module';
import { SourceModule } from '../source/source.module';
import { AnimeController } from './anime.controller';
import { AnimeService } from './anime.service';

@Module({
  imports: [SourceModule, ProjectionModule],
  controllers: [AnimeController],
  providers: [AnimeService],
  exports: [AnimeService],
})
export class AnimeModule {}
