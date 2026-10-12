-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('READY', 'FAILED');

-- CreateTable
CREATE TABLE "MediaAsset" (
    "sourceUrl" TEXT NOT NULL,
    "status" "MediaAssetStatus" NOT NULL,
    "version" TEXT,
    "widths" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "etag" TEXT,
    "bytes" INTEGER,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("sourceUrl")
);

