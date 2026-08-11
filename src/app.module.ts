import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnimeModule } from './anime/anime.module';
import { CatalogModule } from './catalog/catalog.module';
import { validateEnvironment } from './config/environment';
import { DownloadsModule } from './downloads/downloads.module';
import { HealthModule } from './health/health.module';
import { HomeModule } from './home/home.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectionModule } from './projection/projection.module';
import { ScheduleModule } from './schedule/schedule.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    HealthModule,
    ProjectionModule,
    HomeModule,
    CatalogModule,
    AnimeModule,
    ScheduleModule,
    DownloadsModule,
  ],
})
export class AppModule {}
