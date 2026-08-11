export type SourceStatus = 'UNKNOWN' | 'AIRING' | 'FINISHED' | 'UPCOMING';

export interface SourceCategory {
  id: string;
  name: string;
  slug: string;
}

export type SourceGenre = SourceCategory;

export interface SourceAnimeSummary {
  id: string;
  slug: string;
  title: string;
  synopsis: string | null;
  posterUrl: string;
  backdropUrl: string;
  category: SourceCategory | null;
  genres: SourceGenre[];
  status: SourceStatus;
  startDate: Date | null;
  mature: boolean;
}

export interface SourceEpisode {
  id: string;
  number: number;
  title: string | null;
  imageUrl: string;
  sourcePath: string;
  publishedAt: Date | null;
}

export interface SourceRelation {
  kind:
    | 'PREQUEL'
    | 'SEQUEL'
    | 'MAIN_STORY'
    | 'SIDE_STORY'
    | 'SUMMARY'
    | 'ALTERNATIVE'
    | 'OTHER';
  anime: SourceAnimeSummary;
}

export interface SourceAnimeDetail extends SourceAnimeSummary {
  alternativeTitle: string | null;
  trailerUrl: string | null;
  endDate: Date | null;
  nextEpisodeAt: Date | null;
  episodeCount: number | null;
  score: number | null;
  votes: number | null;
  episodes: SourceEpisode[];
  relations: SourceRelation[];
}

export interface SourceRecentEpisode {
  episode: SourceEpisode;
  anime: SourceAnimeSummary;
}

export interface SourceHome {
  featured: SourceAnimeSummary[];
  recentEpisodes: SourceRecentEpisode[];
  recentAnime: SourceAnimeSummary[];
}

export interface SourceCatalog {
  results: SourceAnimeSummary[];
  page: number;
  perPage: number;
  totalPages: number;
  totalRecords: number;
  categories: SourceCategory[];
  genres: SourceGenre[];
  years: [number, number];
}

export interface SourceScheduleEntry {
  anime: SourceAnimeSummary;
  episode: SourceEpisode;
}

export type SourceDownloadProvider =
  'MEGA' | 'PIXELDRAIN' | 'MP4UPLOAD' | 'ONE_FICHIER';

export interface SourceDownloadLink {
  audio: 'SUB' | 'DUB';
  provider: SourceDownloadProvider;
  url: string;
}

export interface SourceEpisodeDownloads {
  anime: SourceAnimeSummary;
  episode: SourceEpisode;
  links: SourceDownloadLink[];
}
