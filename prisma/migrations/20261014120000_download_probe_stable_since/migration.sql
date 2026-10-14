-- Since when an episode's stored links are as they are; it sets their TTL.
-- Existing probes take what a first probe assumes: the publish time or,
-- without one, when the episode was first seen.
ALTER TABLE "DownloadProbe" ADD COLUMN "stableSince" TIMESTAMP(3);

UPDATE "DownloadProbe" AS p
SET "stableSince" = COALESCE(e."publishedAt", e."createdAt")
FROM "Episode" AS e
WHERE e."id" = p."episodeId";

ALTER TABLE "DownloadProbe" ALTER COLUMN "stableSince" SET NOT NULL;
