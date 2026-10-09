ALTER TABLE "Anime" ADD COLUMN "contentUpdatedAt" TIMESTAMP(3);

-- Best known approximation for existing rows: the last detail fetch, or when
-- the anime was first seen.
UPDATE "Anime" SET "contentUpdatedAt" = COALESCE("detailFetchedAt", "createdAt");

ALTER TABLE "Anime"
  ALTER COLUMN "contentUpdatedAt" SET NOT NULL,
  ALTER COLUMN "contentUpdatedAt" SET DEFAULT CURRENT_TIMESTAMP;
