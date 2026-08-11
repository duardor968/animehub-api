import { Module } from '@nestjs/common';
import { ProjectionModule } from '../projection/projection.module';
import { SourceModule } from '../source/source.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [SourceModule, ProjectionModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
