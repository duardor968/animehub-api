import { Module } from '@nestjs/common';
import { AnimeAv1Service } from './animeav1.service';

@Module({
  providers: [AnimeAv1Service],
  exports: [AnimeAv1Service],
})
export class SourceModule {}
