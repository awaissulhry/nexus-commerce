-- Phase D.4: Bulk CSV/XLSX upload preview state on BulkOperation.
--
-- expiresAt + completedAt + uploadFilename are nullable additions.
-- The PENDING_APPLY status value is just a string — no enum to alter.
-- All idempotent so re-runs are safe.

ALTER TABLE "BulkOperation"
  ADD COLUMN IF NOT EXISTS "expiresAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "uploadFilename" TEXT;

CREATE INDEX IF NOT EXISTS "BulkOperation_status_expiresAt_idx"
  ON "BulkOperation" ("status", "expiresAt");
