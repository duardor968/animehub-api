CREATE TABLE "HomeRefreshLease" (
    "key" TEXT NOT NULL,
    "token" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failures" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "HomeRefreshLease_pkey" PRIMARY KEY ("key")
);
