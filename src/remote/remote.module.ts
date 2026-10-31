import { Module } from '@nestjs/common';
import { RemoteController } from './remote.controller';
import { RemoteEvents } from './remote-events';
import { RemoteService } from './remote.service';
@Module({
  controllers: [RemoteController],
  providers: [RemoteService, RemoteEvents],
})
export class RemoteModule {}
