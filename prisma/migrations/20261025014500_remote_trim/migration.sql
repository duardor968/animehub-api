-- Columns nothing reads: no client shows them and no query filters or sorts by them.
ALTER TABLE "RemoteDevice" DROP COLUMN "createdAt";
ALTER TABLE "RemoteSession" DROP COLUMN "createdAt";
ALTER TABLE "RemoteRequest" DROP COLUMN "acceptedAt",
DROP COLUMN "updatedAt";
