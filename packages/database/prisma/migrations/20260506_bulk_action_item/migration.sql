-- Commit 2 of the bulk-operations rebuild: per-item state table.
-- Foundation for retry of failed items, partial rollback (Commit 12),
-- and conflict detection (Commit 18).

CREATE TABLE IF NOT EXISTS "BulkActionItem" (
  "id"               TEXT PRIMARY KEY,
  "jobId"            TEXT NOT NULL,

  -- Polymorphic target. Exactly one is set per row, matching the job's
  -- actionType target entity (see ACTION_ENTITY in bulk-action.service.ts).
  -- No FK constraints on these — preserve audit history when the
  -- underlying Product / ProductVariation / ChannelListing is deleted
  -- (mirrors the AuditLog.entityId pattern).
  "productId"        TEXT,
  "variationId"      TEXT,
  "channelListingId" TEXT,

  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "errorMessage" TEXT,
  "beforeState"  JSONB,
  "afterState"   JSONB,

  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "BulkActionItem_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "BulkActionJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "BulkActionItem_jobId_idx" ON "BulkActionItem" ("jobId");
CREATE INDEX IF NOT EXISTS "BulkActionItem_jobId_status_idx" ON "BulkActionItem" ("jobId", "status");
CREATE INDEX IF NOT EXISTS "BulkActionItem_productId_idx" ON "BulkActionItem" ("productId");
