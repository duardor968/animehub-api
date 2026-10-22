CREATE TYPE "RemoteRequestStatus" AS ENUM ('pending', 'accepted', 'cancelled', 'requires_attention');
CREATE TABLE "RemoteDevice" (
 "id" TEXT NOT NULL, "name" TEXT NOT NULL, "tokenHash" TEXT NOT NULL,
 "profileRevision" INTEGER NOT NULL DEFAULT 0, "profiles" JSONB NOT NULL DEFAULT '[]',
 "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RemoteDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RemoteDevice_tokenHash_key" ON "RemoteDevice"("tokenHash");
CREATE TABLE "RemoteSession" (
 "id" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RemoteSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RemoteSession_tokenHash_key" ON "RemoteSession"("tokenHash");
CREATE TABLE "RemoteLink" (
 "sessionId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "revokedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RemoteLink_pkey" PRIMARY KEY ("sessionId", "deviceId"),
 CONSTRAINT "RemoteLink_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "RemoteSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "RemoteLink_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "RemoteDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "RemotePairing" (
 "deviceId" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "RemotePairing_pkey" PRIMARY KEY ("deviceId"),
 CONSTRAINT "RemotePairing_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "RemoteDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RemotePairing_codeHash_key" ON "RemotePairing"("codeHash");
CREATE TABLE "RemoteRequest" (
 "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "deviceId" TEXT NOT NULL,
 "idempotencyKey" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "animeSlug" TEXT NOT NULL,
 "episodeNumbers" DOUBLE PRECISION[], "profileId" TEXT NOT NULL, "profileRevision" INTEGER NOT NULL,
 "engine" TEXT NOT NULL, "status" "RemoteRequestStatus" NOT NULL DEFAULT 'pending',
 "reason" TEXT, "acceptedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "RemoteRequest_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "RemoteRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "RemoteSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "RemoteRequest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "RemoteDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RemoteRequest_sessionId_idempotencyKey_key" ON "RemoteRequest"("sessionId", "idempotencyKey");
CREATE INDEX "RemoteRequest_deviceId_status_createdAt_idx" ON "RemoteRequest"("deviceId", "status", "createdAt");
CREATE INDEX "RemoteRequest_sessionId_createdAt_idx" ON "RemoteRequest"("sessionId", "createdAt");
CREATE INDEX "AnimeRelation_targetAnimeId_idx" ON "AnimeRelation"("targetAnimeId");
