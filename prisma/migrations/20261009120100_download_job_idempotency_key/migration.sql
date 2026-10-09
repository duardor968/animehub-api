-- Idempotency-Key support for POST /anime/{slug}/download-jobs. Existing jobs
-- have no key; PostgreSQL unique indexes allow any number of NULLs.
ALTER TABLE "DownloadJob" ADD COLUMN     "idempotencyKeyHash" TEXT,
ADD COLUMN     "replayTokenHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "requestFingerprint" TEXT;

CREATE UNIQUE INDEX "DownloadJob_animeId_idempotencyKeyHash_key" ON "DownloadJob"("animeId", "idempotencyKeyHash");
