import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

export enum RequestedAudioDto {
  SUB = 'SUB',
  DUB = 'DUB',
}

export enum ProviderDto {
  MEGA = 'MEGA',
  PIXELDRAIN = 'PIXELDRAIN',
  MP4UPLOAD = 'MP4UPLOAD',
  ONE_FICHIER = 'ONE_FICHIER',
}

export class ResolveDownloadsDto {
  @ApiProperty({ type: [Number], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? value.map(Number) : value,
  )
  @IsInt({ each: true })
  @Min(0, { each: true })
  episodeNumbers!: number[];

  @ApiProperty({ enum: RequestedAudioDto })
  @IsEnum(RequestedAudioDto)
  audio!: RequestedAudioDto;

  @ApiProperty({ enum: ProviderDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(ProviderDto, { each: true })
  providers!: ProviderDto[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  refresh?: boolean;
}

export class ResolvedLinkDto {
  @ApiProperty({ enum: ProviderDto }) provider!: ProviderDto;
  @ApiProperty() url!: string;
}

export class ResolvedEpisodeDto {
  @ApiProperty() episodeNumber!: number;
  @ApiProperty({ enum: RequestedAudioDto }) audio!: RequestedAudioDto;
  @ApiProperty({ type: [ResolvedLinkDto] }) links!: ResolvedLinkDto[];
  @ApiPropertyOptional({ type: String, nullable: true }) errorCode!:
    string | null;
}

export class ResolveDownloadsDataDto {
  @ApiProperty() packageName!: string;
  @ApiProperty({ type: [ResolvedEpisodeDto] }) episodes!: ResolvedEpisodeDto[];
}

export class ResolveDownloadsResponseDto {
  @ApiProperty({ type: ResolveDownloadsDataDto })
  data!: ResolveDownloadsDataDto;
}

export enum DownloadScopeDto {
  ALL = 'ALL',
  RANGE = 'RANGE',
}

export class CreateDownloadJobDto {
  @ApiProperty({ enum: DownloadScopeDto })
  @IsEnum(DownloadScopeDto)
  scope!: DownloadScopeDto;

  @ApiProperty({ enum: RequestedAudioDto })
  @IsEnum(RequestedAudioDto)
  audio!: RequestedAudioDto;

  @ApiProperty({ enum: ProviderDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(ProviderDto, { each: true })
  providers!: ProviderDto[];

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  from?: number;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  to?: number;
}

export class DownloadJobReceiptDto {
  @ApiProperty() jobId!: string;
  @ApiProperty() accessToken!: string;
  @ApiProperty() expiresAt!: string;
}

export class DownloadJobReceiptResponseDto {
  @ApiProperty({ type: DownloadJobReceiptDto }) data!: DownloadJobReceiptDto;
}

export class DownloadJobDataDto {
  @ApiProperty() id!: string;
  @ApiProperty({
    enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'],
  })
  status!: string;
  @ApiProperty() packageName!: string;
  @ApiProperty() totalItems!: number;
  @ApiProperty() completedItems!: number;
  @ApiProperty() failedItems!: number;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ type: [ResolvedEpisodeDto] }) episodes!: ResolvedEpisodeDto[];
}

export class DownloadJobResponseDto {
  @ApiProperty({ type: DownloadJobDataDto }) data!: DownloadJobDataDto;
}
