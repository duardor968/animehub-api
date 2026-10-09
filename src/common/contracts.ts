import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  ANIMEAV1_CATALOG_MAX_PAGES,
  ANIMEAV1_CATALOG_MAX_RECORDS,
} from '../source/animeav1.constants';
import { RELATION_KINDS } from '../source/source.types';

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

export class FeaturedAnimeDto extends AnimeSummaryDto {
  @ApiProperty({
    type: [CategoryDto],
    description: 'Sorted by name (Spanish collation).',
  })
  genres!: CategoryDto[];
  @ApiPropertyOptional({ type: Number, nullable: true }) episodeCount!:
    number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) trailerUrl!:
    string | null;
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
  @ApiProperty({ type: [FeaturedAnimeDto] }) featured!: FeaturedAnimeDto[];
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
  @ApiProperty({
    description: `Pages reported by the source; never more than ${ANIMEAV1_CATALOG_MAX_PAGES}.`,
  })
  totalPages!: number;
  @ApiProperty({
    description: `Records reported by the source; clamped at ${ANIMEAV1_CATALOG_MAX_RECORDS} (see capped).`,
  })
  totalRecords!: number;
  @ApiProperty({
    description: `true when the source truncated the result set at its maximum of ${ANIMEAV1_CATALOG_MAX_RECORDS} records / ${ANIMEAV1_CATALOG_MAX_PAGES} pages: more titles match than totalRecords and pages beyond ${ANIMEAV1_CATALOG_MAX_PAGES} are empty, so narrow the query (e.g. letter, year or genre filters) to reach them. totalRecords is then a lower bound ("${ANIMEAV1_CATALOG_MAX_RECORDS}+").`,
  })
  capped!: boolean;
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
    enum: RELATION_KINDS,
    description:
      'Source relation label: PREQUEL Precuela, SEQUEL Secuela, MAIN_STORY Historia principal, FULL_STORY Historia completa, SIDE_STORY Historia paralela, SPIN_OFF Spin-off, SUMMARY Resumen, ALTERNATIVE Versión alternativa, ALTERNATIVE_SETTING Ambientación alternativa, OTHER Otro (the source itself gives no specific relation).',
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
  @ApiProperty({
    type: [CategoryDto],
    description: 'Sorted by name (Spanish collation).',
  })
  genres!: CategoryDto[];
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
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Lowest episode number across ALL episodes of the anime (not only this page); null when it has none. Movies are often a single episode 0.',
  })
  firstNumber!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Highest episode number across ALL episodes of the anime (not only this page); null when it has none.',
  })
  lastNumber!: number | null;
}

export class EpisodePageResponseDto {
  @ApiProperty({ type: [EpisodeDto] }) data!: EpisodeDto[];
  @ApiProperty({ type: EpisodePageMetaDto }) meta!: EpisodePageMetaDto;
}

@ApiSchema({
  description:
    'One weekly slot. latestEpisode is the newest episode of the series already published at the source (never a future one); the next expected episode is latestEpisode.number + 1, due 7 days after basisPublishedAt, unless isFinalEpisode.',
})
export class ScheduleEntryDto {
  @ApiProperty({ type: AnimeSummaryDto }) anime!: AnimeSummaryDto;
  @ApiProperty({ type: EpisodeDto }) latestEpisode!: EpisodeDto;
  @ApiProperty({
    format: 'date-time',
    description:
      "Equals latestEpisode.publishedAt. Its weekday and time in the viewer's time zone define the weekly slot; the next episode is expected 7 days later. Entries whose basisPublishedAt is more than 21 days old (hiatus or irregular releases) are omitted.",
  })
  basisPublishedAt!: string;
  @ApiProperty({
    description:
      'latestEpisode completes a finished series: there is no next episode. Such entries are kept for 48 hours after basisPublishedAt.',
  })
  isFinalEpisode!: boolean;
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
