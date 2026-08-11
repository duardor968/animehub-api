import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CategoryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}

export class AnimeSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) synopsis!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) posterUrl!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) backdropUrl!:
    string | null;
  @ApiPropertyOptional({ type: CategoryDto, nullable: true })
  category!: CategoryDto | null;
  @ApiProperty({ enum: ['UNKNOWN', 'AIRING', 'FINISHED', 'UPCOMING'] })
  status!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) startDate!:
    string | null;
  @ApiProperty() mature!: boolean;
}

export class EpisodeDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) title!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) imageUrl!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) publishedAt!:
    string | null;
}

export class RecentEpisodeDto {
  @ApiProperty({ type: AnimeSummaryDto }) anime!: AnimeSummaryDto;
  @ApiProperty({ type: EpisodeDto }) episode!: EpisodeDto;
}

export class FreshnessDto {
  @ApiProperty() fetchedAt!: string;
  @ApiProperty() nextRefreshAt!: string;
  @ApiProperty() stale!: boolean;
}

export class HomeDataDto {
  @ApiProperty({ type: [AnimeSummaryDto] }) featured!: AnimeSummaryDto[];
  @ApiProperty({ type: [RecentEpisodeDto] })
  recentEpisodes!: RecentEpisodeDto[];
  @ApiProperty({ type: [AnimeSummaryDto] }) recentAnime!: AnimeSummaryDto[];
}

export class HomeResponseDto {
  @ApiProperty({ type: HomeDataDto }) data!: HomeDataDto;
  @ApiProperty({ type: FreshnessDto }) meta!: FreshnessDto;
}

export class CatalogMetaDto extends FreshnessDto {
  @ApiProperty() page!: number;
  @ApiProperty() perPage!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() totalRecords!: number;
  @ApiProperty({ type: [CategoryDto] }) categories!: CategoryDto[];
  @ApiProperty({ type: [CategoryDto] }) genres!: CategoryDto[];
  @ApiProperty({ type: [Number], minItems: 2, maxItems: 2 })
  years!: [number, number];
}

export class CatalogResponseDto {
  @ApiProperty({ type: [AnimeSummaryDto] }) data!: AnimeSummaryDto[];
  @ApiProperty({ type: CatalogMetaDto }) meta!: CatalogMetaDto;
}

export class SuggestionResponseDto {
  @ApiProperty({ type: [AnimeSummaryDto] }) data!: AnimeSummaryDto[];
}

export class RelationDto {
  @ApiProperty({
    enum: [
      'PREQUEL',
      'SEQUEL',
      'MAIN_STORY',
      'SIDE_STORY',
      'SUMMARY',
      'ALTERNATIVE',
      'OTHER',
    ],
  })
  kind!: string;
  @ApiProperty({ type: AnimeSummaryDto }) anime!: AnimeSummaryDto;
  @ApiProperty() position!: number;
}

export class AnimeDetailDto extends AnimeSummaryDto {
  @ApiPropertyOptional({ type: String, nullable: true }) alternativeTitle!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) trailerUrl!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) endDate!:
    string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) nextEpisodeAt!:
    string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) episodeCount!:
    number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) score!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) votes!: number | null;
  @ApiProperty() sourceUrl!: string;
  @ApiProperty({ type: [CategoryDto] }) genres!: CategoryDto[];
  @ApiProperty({ type: [RelationDto] }) relations!: RelationDto[];
}

export class AnimeResponseDto {
  @ApiProperty({ type: AnimeDetailDto }) data!: AnimeDetailDto;
  @ApiProperty({ type: FreshnessDto }) meta!: FreshnessDto;
}

export class EpisodePageMetaDto {
  @ApiProperty() page!: number;
  @ApiProperty() perPage!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() totalRecords!: number;
}

export class EpisodePageResponseDto {
  @ApiProperty({ type: [EpisodeDto] }) data!: EpisodeDto[];
  @ApiProperty({ type: EpisodePageMetaDto }) meta!: EpisodePageMetaDto;
}

export class ScheduleEntryDto {
  @ApiProperty({ type: AnimeSummaryDto }) anime!: AnimeSummaryDto;
  @ApiProperty({ type: EpisodeDto }) latestEpisode!: EpisodeDto;
  @ApiProperty() basisPublishedAt!: string;
}

export class ScheduleResponseDto {
  @ApiProperty({ type: [ScheduleEntryDto] }) data!: ScheduleEntryDto[];
  @ApiProperty({ type: FreshnessDto }) meta!: FreshnessDto;
}

export class ProblemDetailsDto {
  @ApiProperty() type!: string;
  @ApiProperty() title!: string;
  @ApiProperty() status!: number;
  @ApiProperty() detail!: string;
  @ApiProperty() instance!: string;
  @ApiPropertyOptional() requestId?: string;
}
