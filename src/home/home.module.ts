import { Module } from '@nestjs/common';
import { AnimeModule } from '../anime/anime.module';
import { ProjectionModule } from '../projection/projection.module';
import { SourceModule } from '../source/source.module';
import { HomeController } from './home.controller';
import { HomeRefreshScheduler } from './home-refresh.scheduler';
import { HomeService } from './home.service';

@Module({
  imports: [SourceModule, ProjectionModule, AnimeModule],
  controllers: [HomeController],
  providers: [HomeService, HomeRefreshScheduler],
})
export class HomeModule {}
