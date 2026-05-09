-- W5.49 — ListingRecoveryEvent audit table.
--
-- One row per operator-initiated recovery action (the 5 scenarios:
-- REPUBLISH_IN_PLACE / DELETE_RELIST_SAME / SAME_ASIN_NEW_SKU /
-- NEW_ASIN_SAME_SKU / FULL_RESET). Captures the before/after ASIN +
-- SKU, lifecycle state, completed-steps array for streaming progress
-- to the UI, error + Amazon submission IDs for cross-reference, and
-- timing fields for the durationMs metric.
--
-- Index choices:
--   productId — every per-product detail view filters on this
--   (channel, marketplace) — drill-down "every recovery on AMAZON IT"
--   status — active-recovery dashboard ("show me everything PENDING
--            or IN_FLIGHT right now")
--   action — analytics ("how often do we hit FULL_RESET?")
--   startedAt — chronological recovery log
--
-- Idempotent CREATE TABLE / CREATE INDEX with IF NOT EXISTS. Rollback
-- drops the table.

CREATE TABLE IF NOT EXISTS "ListingRecoveryEvent" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "oldAsin" TEXT,
  "newAsin" TEXT,
  "oldSku" TEXT,
  "newSku" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "completedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "error" TEXT,
  "amazonSubmissionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "initiatedBy" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  CONSTRAINT "ListingRecoveryEvent_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ListingRecoveryEvent"
    ADD CONSTRAINT "ListingRecoveryEvent_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ListingRecoveryEvent_productId_idx"
  ON "ListingRecoveryEvent" ("productId");
CREATE INDEX IF NOT EXISTS "ListingRecoveryEvent_channel_marketplace_idx"
  ON "ListingRecoveryEvent" ("channel", "marketplace");
CREATE INDEX IF NOT EXISTS "ListingRecoveryEvent_status_idx"
  ON "ListingRecoveryEvent" ("status");
CREATE INDEX IF NOT EXISTS "ListingRecoveryEvent_action_idx"
  ON "ListingRecoveryEvent" ("action");
CREATE INDEX IF NOT EXISTS "ListingRecoveryEvent_startedAt_idx"
  ON "ListingRecoveryEvent" ("startedAt");
