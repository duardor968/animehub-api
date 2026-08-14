import {
  AnimeDetailDto,
  AnimeSummaryDto,
  CategoryDto,
  EpisodeDto,
  FeaturedAnimeDto,
  RelationDto,
} from './contracts';

interface CategoryRecord {
  sourceId: string;
  name: string;
  slug: string;
}

interface GenreRecord {
  genre: CategoryRecord;
}

interface AnimeRecord {
  sourceId: string;
  slug: string;
  title: string;
  alternativeTitle?: string | null;
  synopsis: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  trailerUrl?: string | null;
  status: string;
  category: CategoryRecord | null;
  startDate: Date | null;
  endDate?: Date | null;
  nextEpisodeAt?: Date | null;
  episodeCount?: number | null;
  score?: number | null;
  votes?: number | null;
  mature: boolean;
  sourceUrl?: string;
  genres?: GenreRecord[];
  outgoingRelations?: RelationRecord[];
}

interface EpisodeRecord {
  sourceId: string;
  number: number;
  title: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
}

interface RelationRecord {
  kind: string;
  position: number;
  targetAnime: AnimeRecord | null;
  targetSourceId: string | null;
  targetSlug: string;
  targetTitle: string;
  targetPosterUrl: string | null;
  targetYear: number | null;
}

export function serializeCategory(category: CategoryRecord): CategoryDto {
  return { id: category.sourceId, name: category.name, slug: category.slug };
}

export function serializeAnime(anime: AnimeRecord): AnimeSummaryDto {
  return {
    id: anime.sourceId,
    slug: anime.slug,
    title: anime.title,
    synopsis: anime.synopsis,
    posterUrl: anime.posterUrl,
    backdropUrl: anime.backdropUrl,
    category: anime.category ? serializeCategory(anime.category) : null,
    status: anime.status,
    startDate: anime.startDate?.toISOString() ?? null,
    mature: anime.mature,
  };
}

export function serializeFeatured(anime: AnimeRecord): FeaturedAnimeDto {
  return {
    ...serializeAnime(anime),
    genres: (anime.genres ?? []).map(({ genre }) => serializeCategory(genre)),
    episodeCount: anime.episodeCount ?? null,
    trailerUrl: anime.trailerUrl ?? null,
  };
}

export function serializeEpisode(episode: EpisodeRecord): EpisodeDto {
  return {
    id: episode.sourceId,
    number: episode.number,
    title: episode.title,
    imageUrl: episode.imageUrl,
    publishedAt: episode.publishedAt?.toISOString() ?? null,
  };
}

export function serializeDetail(anime: AnimeRecord): AnimeDetailDto {
  return {
    ...serializeAnime(anime),
    alternativeTitle: anime.alternativeTitle ?? null,
    trailerUrl: anime.trailerUrl ?? null,
    endDate: anime.endDate?.toISOString() ?? null,
    nextEpisodeAt: anime.nextEpisodeAt?.toISOString() ?? null,
    episodeCount: anime.episodeCount ?? null,
    score: anime.score ?? null,
    votes: anime.votes ?? null,
    sourceUrl: anime.sourceUrl ?? `https://animeav1.com/media/${anime.slug}`,
    genres: (anime.genres ?? []).map(({ genre }) => serializeCategory(genre)),
    relations: (anime.outgoingRelations ?? []).map(serializeRelation),
  };
}

function serializeRelation(relation: RelationRecord): RelationDto {
  const fallback: AnimeRecord = {
    sourceId: relation.targetSourceId ?? relation.targetSlug,
    slug: relation.targetSlug,
    title: relation.targetTitle,
    synopsis: null,
    posterUrl: relation.targetPosterUrl,
    backdropUrl: null,
    status: 'UNKNOWN',
    category: null,
    startDate: relation.targetYear
      ? new Date(Date.UTC(relation.targetYear, 0, 1))
      : null,
    mature: false,
  };
  return {
    kind: relation.kind,
    position: relation.position,
    anime: serializeAnime(relation.targetAnime ?? fallback),
  };
}
