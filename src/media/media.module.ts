import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JobsModule } from '../jobs/job-queue';
import { MediaInterceptor } from './media.interceptor';
import { MediaService } from './media.service';

@Module({
  imports: [JobsModule],
  providers: [
    MediaService,
    { provide: APP_INTERCEPTOR, useClass: MediaInterceptor },
  ],
})
export class MediaModule {}
