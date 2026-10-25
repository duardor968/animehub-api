import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  DeviceRemoteRequestDto,
  DeviceRemoteRequestsDto,
  RemoteBrowserLinksDto,
  RemoteBrowserRevocationDto,
  RemoteCredentialDto,
  RemotePairingDto,
  RemoteRequestDto,
  RemoteRequestsDto,
  RemoteDevicesDto,
  RemoteLinkDto,
  RemoteRevocationDto,
  RemoteRevisionDto,
  AckRemoteRequestDto,
  CreateRemoteRequestDto,
  PairDeviceDto,
  PublishProfilesDto,
  RegisterDeviceDto,
} from './remote.dto';
import { RemoteService } from './remote.service';

@ApiTags('remote desktop')
@ApiBearerAuth('remoteCapability')
@Controller('remote')
export class RemoteController {
  constructor(private readonly remote: RemoteService) {}
  @Post('devices')
  @RouteConfig({ rateLimit: { max: 5, timeWindow: '1 hour' } })
  @ApiOperation({ security: [] })
  @ApiCreatedResponse({ type: RemoteCredentialDto })
  register(@Body() dto: RegisterDeviceDto) {
    return this.remote.register(dto.name);
  }
  @Post('sessions')
  @RouteConfig({ rateLimit: { max: 10, timeWindow: '1 hour' } })
  @ApiOperation({ security: [] })
  @ApiCreatedResponse({ type: RemoteCredentialDto })
  session() {
    return this.remote.createSession();
  }
  @Post('devices/me/pairing')
  @RouteConfig({ rateLimit: { max: 5, timeWindow: '10 minutes' } })
  @ApiCreatedResponse({ type: RemotePairingDto })
  pairing(@Headers('authorization') auth?: string) {
    return this.remote.pairing(auth);
  }
  @Post('links')
  @RouteConfig({ rateLimit: { max: 5, timeWindow: '10 minutes' } })
  @ApiCreatedResponse({ type: RemoteLinkDto })
  pair(@Body() dto: PairDeviceDto, @Headers('authorization') auth?: string) {
    return this.remote.pair(dto.code, auth);
  }
  @Get('devices')
  @ApiOkResponse({ type: RemoteDevicesDto })
  devices(@Headers('authorization') auth?: string) {
    return this.remote.devices(auth);
  }
  @Put('devices/me/profiles')
  @ApiOkResponse({ type: RemoteRevisionDto })
  profiles(
    @Body() dto: PublishProfilesDto,
    @Headers('authorization') auth?: string,
  ) {
    return this.remote.publish(dto, auth);
  }
  @Post('requests')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'UUID unique within this browser session',
  })
  @ApiCreatedResponse({ type: RemoteRequestDto })
  create(
    @Body() dto: CreateRemoteRequestDto,
    @Headers('idempotency-key') key?: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.remote
      .create(dto, key, auth)
      .then((value) => this.remote.withTitles(value));
  }
  @Get('requests')
  @ApiOkResponse({ type: RemoteRequestsDto })
  requests(@Headers('authorization') auth?: string) {
    return this.remote
      .requests(auth)
      .then((value) => this.remote.withTitles(value));
  }
  @Get('devices/me/inbox')
  @ApiOkResponse({ type: DeviceRemoteRequestsDto })
  inbox(@Headers('authorization') auth?: string) {
    return this.remote.inbox(auth);
  }
  @Get('devices/me/inbox/:id')
  @ApiOkResponse({ type: DeviceRemoteRequestDto })
  request(@Param('id') id: string, @Headers('authorization') auth?: string) {
    return this.remote.deviceRequest(id, auth);
  }
  @Post('devices/me/inbox/:id/ack')
  @HttpCode(200)
  @ApiOkResponse({ type: DeviceRemoteRequestDto })
  ack(
    @Param('id') id: string,
    @Body() dto: AckRemoteRequestDto,
    @Headers('authorization') auth?: string,
  ) {
    return this.remote.ack(id, dto, auth);
  }
  @Post('requests/:id/cancel')
  @HttpCode(200)
  @ApiOkResponse({ type: RemoteRequestDto })
  cancel(@Param('id') id: string, @Headers('authorization') auth?: string) {
    return this.remote
      .cancel(id, auth)
      .then((value) => this.remote.withTitles(value));
  }
  @Get('devices/me/links')
  @ApiOkResponse({ type: RemoteBrowserLinksDto })
  deviceLinks(@Headers('authorization') auth?: string) {
    return this.remote.deviceLinks(auth);
  }
  @Delete('devices/me/links/:id')
  @ApiOkResponse({ type: RemoteBrowserRevocationDto })
  revokeBrowser(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.remote.revokeBrowser(id, auth);
  }
  @Delete('links/:deviceId')
  @ApiOkResponse({ type: RemoteRevocationDto })
  revoke(
    @Param('deviceId') id: string,
    @Headers('authorization') auth?: string,
  ) {
    return this.remote.revoke(id, auth);
  }
}
