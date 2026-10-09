import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

// Episode numbers are floats at the source (specials such as 12.5 exist), and
// movies are commonly a single episode 0.
const finiteNumber = { allowNaN: false, allowInfinity: false } as const;

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
  @IsNumber(finiteNumber, { each: true })
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
  EPISODES = 'EPISODES',
}

export const MAX_JOB_EPISODE_NUMBERS = 5000;

const absent = (value: unknown) => value === undefined || value === null;

export function downloadScopeFieldsError(job: {
  scope?: unknown;
  from?: unknown;
  to?: unknown;
  episodeNumbers?: unknown;
}): string | null {
  switch (job.scope) {
    case DownloadScopeDto.RANGE:
      if (!absent(job.episodeNumbers))
        return 'episodeNumbers is only allowed when scope is EPISODES.';
      if (absent(job.from) || absent(job.to))
        return 'RANGE requires both from and to.';
      if (
        typeof job.from === 'number' &&
        typeof job.to === 'number' &&
        job.from > job.to
      )
        return 'from must be less than or equal to to.';
      return null;
    case DownloadScopeDto.EPISODES:
      if (!absent(job.from) || !absent(job.to))
        return 'from and to are only allowed when scope is RANGE.';
      if (absent(job.episodeNumbers))
        return 'EPISODES requires episodeNumbers.';
      return null;
    case DownloadScopeDto.ALL:
      // from/to are ignored for ALL: older clients send them along.
      if (!absent(job.episodeNumbers))
        return 'episodeNumbers is only allowed when scope is EPISODES.';
      return null;
    default:
      return null; // @IsEnum reports unknown scopes.
  }
}

@ValidatorConstraint({ name: 'downloadScopeFields' })
class DownloadScopeFieldsConstraint implements ValidatorConstraintInterface {
  validate(_scope: unknown, args: ValidationArguments) {
    return downloadScopeFieldsError(args.object) === null;
  }

  defaultMessage(args: ValidationArguments) {
    return (
      downloadScopeFieldsError(args.object) ??
      'The fields do not match the scope.'
    );
  }
}

// Validation model for POST /anime/{slug}/download-jobs. Its OpenAPI shape is
// the discriminated union of the *DownloadJobRequestDto classes below.
export class CreateDownloadJobDto {
  @IsEnum(DownloadScopeDto)
  @Validate(DownloadScopeFieldsConstraint)
  scope!: DownloadScopeDto;

  @IsEnum(RequestedAudioDto)
  audio!: RequestedAudioDto;

  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(ProviderDto, { each: true })
  providers!: ProviderDto[];

  @IsOptional()
  @IsNumber(finiteNumber)
  @Min(0)
  from?: number;

  @IsOptional()
  @IsNumber(finiteNumber)
  @Min(0)
  to?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_JOB_EPISODE_NUMBERS)
  @IsNumber(finiteNumber, { each: true })
  @Min(0, { each: true })
  @ArrayUnique()
  episodeNumbers?: number[];
}

class DownloadJobOptionsDto {
  @ApiProperty({ enum: RequestedAudioDto })
  audio!: RequestedAudioDto;

  @ApiProperty({ enum: ProviderDto, isArray: true, minItems: 1 })
  providers!: ProviderDto[];
}

export class AllDownloadJobRequestDto extends DownloadJobOptionsDto {
  @ApiProperty({
    enum: [DownloadScopeDto.ALL],
    description: 'Every episode of the anime.',
  })
  scope!: DownloadScopeDto.ALL;
}

export class RangeDownloadJobRequestDto extends DownloadJobOptionsDto {
  @ApiProperty({
    enum: [DownloadScopeDto.RANGE],
    description:
      'Every existing episode whose number is within [from, to] (inclusive).',
  })
  scope!: DownloadScopeDto.RANGE;

  @ApiProperty({ minimum: 0, description: 'Required; from <= to.' })
  from!: number;

  @ApiProperty({ minimum: 0, description: 'Required; to >= from.' })
  to!: number;
}

export class EpisodesDownloadJobRequestDto extends DownloadJobOptionsDto {
  @ApiProperty({
    enum: [DownloadScopeDto.EPISODES],
    description: 'Exactly the listed episodes.',
  })
  scope!: DownloadScopeDto.EPISODES;

  @ApiProperty({
    type: [Number],
    minItems: 1,
    maxItems: MAX_JOB_EPISODE_NUMBERS,
    uniqueItems: true,
    description:
      'Episode numbers to resolve (finite, >= 0, decimals allowed, no duplicates). Numbers the anime does not have are skipped and listed in the receipt as missingEpisodeNumbers; if none exists the request fails with 400.',
  })
  episodeNumbers!: number[];
}

export class DownloadJobReceiptDto {
  @ApiProperty() jobId!: string;
  @ApiProperty() accessToken!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({
    type: [Number],
    description:
      'EPISODES scope only: requested numbers the anime does not have, which the job skips (ascending). Always empty for ALL and RANGE.',
  })
  missingEpisodeNumbers!: number[];
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
