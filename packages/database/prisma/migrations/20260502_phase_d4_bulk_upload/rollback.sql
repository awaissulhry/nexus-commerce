-- Rollback for D.4: drop the new BulkOperation columns + index.
DROP INDEX IF EXISTS "BulkOperation_status_expiresAt_idx";
ALTER TABLE "BulkOperation"
  DROP COLUMN IF EXISTS "uploadFilename",
  DROP COLUMN IF EXISTS "completedAt",
  DROP COLUMN IF EXISTS "expiresAt";
