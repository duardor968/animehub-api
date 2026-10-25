import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDeviceDto {
  @ApiProperty() @IsString() @MaxLength(80) @Matches(/\S/) name!: string;
}
export class PairDeviceDto {
  @ApiProperty({ pattern: '^\\d{6}$' }) @Matches(/^\d{6}$/) code!: string;
}
export class DestinationProfileDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9_-]{1,64}$/) id!: string;
  @ApiProperty() @IsString() @MaxLength(80) @Matches(/\S/) label!: string;
  @ApiProperty({ enum: ['direct', 'jdownloader'] })
  @IsIn(['direct', 'jdownloader'])
  engine!: string;
  @ApiProperty() @IsBoolean() isDefault!: boolean;
}
export class PublishProfilesDto {
  @ApiProperty() @IsInt() @Min(1) revision!: number;
  @ApiProperty({ type: [DestinationProfileDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DestinationProfileDto)
  profiles!: DestinationProfileDto[];
}
export class CreateRemoteRequestDto {
  @ApiProperty() @IsUUID() deviceId!: string;
  @ApiProperty()
  @IsString()
  @MaxLength(1024)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  animeSlug!: string;
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ArrayUnique()
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  @Min(0, { each: true })
  episodeNumbers!: number[];
  @ApiProperty()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  profileId!: string;
  @ApiProperty() @IsInt() @Min(1) profileRevision!: number;
  @ApiProperty({ enum: ['direct', 'jdownloader'] })
  @IsIn(['direct', 'jdownloader'])
  engine!: string;
}
export class AckRemoteRequestDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
  @ApiProperty({ enum: ['accepted', 'requires_attention'] })
  @IsIn(['accepted', 'requires_attention'])
  status!: 'accepted' | 'requires_attention';
}

export class RemoteCredentialDto {
  @ApiProperty() id!: string;
  @ApiProperty({
    description: 'Secret shown once; never place in URLs or logs',
  })
  token!: string;
}
export class RemotePairingDto {
  @ApiProperty() code!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
/** A request as the PC reads it. */
export class DeviceRemoteRequestDto {
  @ApiProperty() id!: string;
  @ApiProperty() deviceId!: string;
  @ApiProperty() animeSlug!: string;
  @ApiProperty({ type: [Number] }) episodeNumbers!: number[];
  @ApiProperty() profileId!: string;
  @ApiProperty() profileRevision!: number;
  @ApiProperty({ enum: ['direct', 'jdownloader'] }) engine!: string;
  @ApiProperty({
    enum: ['pending', 'accepted', 'cancelled', 'requires_attention'],
  })
  status!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
}
export class DeviceRemoteRequestsDto {
  @ApiProperty({ type: [DeviceRemoteRequestDto] })
  requests!: DeviceRemoteRequestDto[];
}
/** A request as the browser that sent it reads it. */
export class RemoteRequestDto extends DeviceRemoteRequestDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Current canonical catalog title; null when catalog metadata is unavailable',
  })
  animeTitle!: string | null;
}
export class RemoteRequestsDto {
  @ApiProperty({ type: [RemoteRequestDto] }) requests!: RemoteRequestDto[];
}
export class RemoteDeviceDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() profileRevision!: number;
  @ApiProperty({ type: [DestinationProfileDto] })
  profiles!: DestinationProfileDto[];
  @ApiProperty({ format: 'date-time' }) lastSeenAt!: string;
}
export class RemoteDevicesDto {
  @ApiProperty({ type: [RemoteDeviceDto] }) devices!: RemoteDeviceDto[];
}
export class RemoteLinkDto {
  @ApiProperty() deviceId!: string;
}
export class RemoteRevocationDto extends RemoteLinkDto {
  @ApiProperty() revoked!: boolean;
}
export class RemoteRevisionDto {
  @ApiProperty() revision!: number;
}
export class RemoteBrowserLinkDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class RemoteBrowserLinksDto {
  @ApiProperty({ type: [RemoteBrowserLinkDto] }) links!: RemoteBrowserLinkDto[];
}
export class RemoteBrowserRevocationDto {
  @ApiProperty() id!: string;
  @ApiProperty() revoked!: boolean;
}
