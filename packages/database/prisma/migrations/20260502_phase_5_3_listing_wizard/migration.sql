-- Phase 5.3: ListingWizard — guided 10-step listing flow.
--
-- Idempotent CREATE TABLE so re-runs are safe.

CREATE TABLE IF NOT EXISTS "ListingWizard" (
  "id"          TEXT PRIMARY KEY,
  "productId"   TEXT NOT NULL,
  "channel"     TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "currentStep" INTEGER NOT NULL DEFAULT 1,
  "state"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status"      TEXT NOT NULL DEFAULT 'DRAFT',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "ListingWizard_productId_channel_marketplace_idx"
  ON "ListingWizard" ("productId", "channel", "marketplace");

CREATE INDEX IF NOT EXISTS "ListingWizard_status_idx"
  ON "ListingWizard" ("status");
