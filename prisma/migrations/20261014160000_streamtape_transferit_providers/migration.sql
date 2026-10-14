-- AnimeAV1 mirrors that downloads now keep: StreamTape, and Transfer.it,
-- which clients offer only to copy (JDownloader has no plugin for it).
ALTER TYPE "DownloadProvider" ADD VALUE 'STREAMTAPE';
ALTER TYPE "DownloadProvider" ADD VALUE 'TRANSFERIT';

-- Stored links were filtered without them: re-probe on the next request.
UPDATE "DownloadProbe" SET "expiresAt" = CURRENT_TIMESTAMP;
