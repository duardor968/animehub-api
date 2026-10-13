-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('READY', 'FAILED', 'MISSING');

-- CreateTable
CREATE TABLE "MediaAsset" (
    "sourceUrl" TEXT NOT NULL,
    "status" "MediaAssetStatus" NOT NULL,
    "version" TEXT,
    "widths" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "etag" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("sourceUrl")
);

