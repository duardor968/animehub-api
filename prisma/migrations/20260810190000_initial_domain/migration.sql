-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AnimeStatus" AS ENUM ('UNKNOWN', 'AIRING', 'FINISHED', 'UPCOMING');

-- CreateEnum
CREATE TYPE "SourceAvailability" AS ENUM ('AVAILABLE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "SnapshotKind" AS ENUM ('HOME_FEATURED', 'HOME_RECENT_EPISODES', 'HOME_RECENT_ANIME', 'CATALOG', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "RelationKind" AS ENUM ('PREQUEL', 'SEQUEL', 'MAIN_STORY', 'SIDE_STORY', 'SUMMARY', 'ALTERNATIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "AudioType" AS ENUM ('SUB', 'DUB');

-- CreateEnum
CREATE TYPE "DownloadProvider" AS ENUM ('MEGA', 'PIXELDRAIN', 'MP4UPLOAD', 'ONE_FICHIER');

-- CreateEnum
CREATE TYPE "DownloadJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DownloadJobItemStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Genre" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "Genre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnimeGenre" (
    "animeId" TEXT NOT NULL,
    "genreId" TEXT NOT NULL,

    CONSTRAINT "AnimeGenre_pkey" PRIMARY KEY ("animeId","genreId")
);

-- CreateTable
CREATE TABLE "Anime" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "alternativeTitle" TEXT,
    "synopsis" TEXT,
    "posterUrl" TEXT,
    "backdropUrl" TEXT,
    "trailerUrl" TEXT,
    "status" "AnimeStatus" NOT NULL DEFAULT 'UNKNOWN',
    "availability" "SourceAvailability" NOT NULL DEFAULT 'AVAILABLE',
    "categoryId" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "nextEpisodeAt" TIMESTAMP(3),
    "latestEpisodePublishedAt" TIMESTAMP(3),
    "episodeCount" INTEGER,
    "score" DOUBLE PRECISION,
    "votes" INTEGER,
    "mature" BOOLEAN NOT NULL DEFAULT false,
    "sourceUrl" TEXT NOT NULL,
    "notFoundCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastFetchedAt" TIMESTAMP(3) NOT NULL,
    "detailFetchedAt" TIMESTAMP(3),
    "nextRefreshAt" TIMESTAMP(3) NOT NULL,
    "unchangedRefreshes" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Anime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "animeId" TEXT NOT NULL,
    "number" DOUBLE PRECISION NOT NULL,
    "title" TEXT,
    "sourcePath" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnimeRelation" (
    "id" TEXT NOT NULL,
    "sourceAnimeId" TEXT NOT NULL,
    "targetAnimeId" TEXT,
    "targetSourceId" TEXT,
    "targetSlug" TEXT NOT NULL,
    "targetTitle" TEXT NOT NULL,
    "targetPosterUrl" TEXT,
    "targetYear" INTEGER,
    "kind" "RelationKind" NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "AnimeRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "SnapshotKind" NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "nextRefreshAt" TIMESTAMP(3) NOT NULL,
    "totalPages" INTEGER,
    "totalRecords" INTEGER,
    "minYear" INTEGER,
    "maxYear" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotItem" (
    "snapshotId" TEXT NOT NULL,
    "animeId" TEXT NOT NULL,
    "episodeId" TEXT,
    "position" INTEGER NOT NULL,
    "label" TEXT,

    CONSTRAINT "SnapshotItem_pkey" PRIMARY KEY ("snapshotId","position")
);

-- CreateTable
CREATE TABLE "DownloadLink" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "audio" "AudioType" NOT NULL,
    "provider" "DownloadProvider" NOT NULL,
    "url" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownloadProbe" (
    "episodeId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadProbe_pkey" PRIMARY KEY ("episodeId")
);

-- CreateTable
CREATE TABLE "DownloadJob" (
    "id" TEXT NOT NULL,
    "animeId" TEXT NOT NULL,
    "accessTokenHash" TEXT NOT NULL,
    "status" "DownloadJobStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedAudio" "AudioType" NOT NULL,
    "providers" "DownloadProvider"[],
    "packageName" TEXT NOT NULL,
    "totalItems" INTEGER NOT NULL,
    "completedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownloadJobItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "status" "DownloadJobItemStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedAudio" "AudioType",
    "links" JSONB,
    "errorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadJobItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_sourceId_key" ON "Category"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Genre_sourceId_key" ON "Genre"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Genre_slug_key" ON "Genre"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Anime_sourceId_key" ON "Anime"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Anime_slug_key" ON "Anime"("slug");

-- CreateIndex
CREATE INDEX "Anime_status_nextRefreshAt_idx" ON "Anime"("status", "nextRefreshAt");

-- CreateIndex
CREATE INDEX "Anime_availability_title_idx" ON "Anime"("availability", "title");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_sourceId_key" ON "Episode"("sourceId");

-- CreateIndex
CREATE INDEX "Episode_animeId_number_idx" ON "Episode"("animeId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_animeId_number_key" ON "Episode"("animeId", "number");

-- CreateIndex
CREATE INDEX "AnimeRelation_sourceAnimeId_position_idx" ON "AnimeRelation"("sourceAnimeId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AnimeRelation_sourceAnimeId_targetSlug_kind_key" ON "AnimeRelation"("sourceAnimeId", "targetSlug", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Snapshot_key_key" ON "Snapshot"("key");

-- CreateIndex
CREATE INDEX "Snapshot_kind_nextRefreshAt_idx" ON "Snapshot"("kind", "nextRefreshAt");

-- CreateIndex
CREATE INDEX "SnapshotItem_animeId_idx" ON "SnapshotItem"("animeId");

-- CreateIndex
CREATE INDEX "DownloadLink_episodeId_expiresAt_idx" ON "DownloadLink"("episodeId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DownloadLink_episodeId_audio_provider_url_key" ON "DownloadLink"("episodeId", "audio", "provider", "url");

-- CreateIndex
CREATE INDEX "DownloadProbe_expiresAt_idx" ON "DownloadProbe"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DownloadJob_accessTokenHash_key" ON "DownloadJob"("accessTokenHash");

-- CreateIndex
CREATE INDEX "DownloadJob_status_createdAt_idx" ON "DownloadJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DownloadJob_expiresAt_idx" ON "DownloadJob"("expiresAt");

-- CreateIndex
CREATE INDEX "DownloadJobItem_jobId_status_idx" ON "DownloadJobItem"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DownloadJobItem_jobId_episodeId_key" ON "DownloadJobItem"("jobId", "episodeId");

-- AddForeignKey
ALTER TABLE "AnimeGenre" ADD CONSTRAINT "AnimeGenre_animeId_fkey" FOREIGN KEY ("animeId") REFERENCES "Anime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnimeGenre" ADD CONSTRAINT "AnimeGenre_genreId_fkey" FOREIGN KEY ("genreId") REFERENCES "Genre"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Anime" ADD CONSTRAINT "Anime_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_animeId_fkey" FOREIGN KEY ("animeId") REFERENCES "Anime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnimeRelation" ADD CONSTRAINT "AnimeRelation_sourceAnimeId_fkey" FOREIGN KEY ("sourceAnimeId") REFERENCES "Anime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnimeRelation" ADD CONSTRAINT "AnimeRelation_targetAnimeId_fkey" FOREIGN KEY ("targetAnimeId") REFERENCES "Anime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotItem" ADD CONSTRAINT "SnapshotItem_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotItem" ADD CONSTRAINT "SnapshotItem_animeId_fkey" FOREIGN KEY ("animeId") REFERENCES "Anime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotItem" ADD CONSTRAINT "SnapshotItem_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadLink" ADD CONSTRAINT "DownloadLink_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadProbe" ADD CONSTRAINT "DownloadProbe_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadJob" ADD CONSTRAINT "DownloadJob_animeId_fkey" FOREIGN KEY ("animeId") REFERENCES "Anime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadJobItem" ADD CONSTRAINT "DownloadJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "DownloadJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadJobItem" ADD CONSTRAINT "DownloadJobItem_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
