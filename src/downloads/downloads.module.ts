import { Module } from '@nestjs/common';
import { AnimeModule } from '../anime/anime.module';
import { JobsModule } from '../jobs/job-queue';
import { SourceModule } from '../source/source.module';
import { DownloadController } from './download.controller';
import { DownloadJobsController } from './download-jobs.controller';
import { DownloadJobsService } from './download-jobs.service';
import { DownloadResolverService } from './download-resolver.service';

@Module({
  imports: [AnimeModule, SourceModule, JobsModule],
  controllers: [DownloadController, DownloadJobsController],
  providers: [DownloadResolverService, DownloadJobsService],
})
export class DownloadsModule {}
