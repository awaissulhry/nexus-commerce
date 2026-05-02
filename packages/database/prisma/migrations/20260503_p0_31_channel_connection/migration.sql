-- P0 #31: ChannelConnection — third-party OAuth + sync state for
-- eBay (and eventually Shopify / WooCommerce / Etsy). The model
-- existed in schema.prisma without a corresponding migration; the
-- entire eBay subsystem (auth + listings + orders, ~6 routes / 13
-- service files) crashes at runtime the moment a connection is
-- created. Caught by the schema-drift gate landed in P0 #0.
--
-- Phase 1B audit also surfaced extensive column-level drift on
-- VariantChannelListing — schema describes channelConnectionId,
-- externalListingId, externalSku, listingUrl, currentPrice, quantity,
-- quantitySold, none of which any prior migration created. Code paths
-- under /api/sync/ebay/* both read and write all of them, so the eBay
-- listing flow would still crash post-ChannelConnection without these
-- column adds. Same root-cause class, fixed in one consolidated
-- migration to keep the deploy single-step.
--
-- Idempotent throughout (CREATE TABLE / ADD COLUMN / DO blocks all
-- IF NOT EXISTS guarded).

CREATE TABLE IF NOT EXISTS "ChannelConnection" (
  "id"                   TEXT PRIMARY KEY,
  "channelType"          TEXT NOT NULL,

  -- eBay OAuth2 credentials
  "ebayAccessToken"      TEXT,
  "ebayRefreshToken"     TEXT,
  "ebayTokenExpiresAt"   TIMESTAMP(3),
  "ebayDevId"            TEXT,
  "ebayAppId"            TEXT,
  "ebaySignInName"       TEXT,
  "ebayStoreName"        TEXT,
  "ebayStoreFrontUrl"    TEXT,

  -- Connection status
  "isActive"             BOOLEAN NOT NULL DEFAULT false,
  "lastSyncAt"           TIMESTAMP(3),
  "lastSyncStatus"       TEXT,
  "lastSyncError"        TEXT,

  -- Free-form per-channel metadata
  "connectionMetadata"   JSONB,

  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ChannelConnection_channelType_idx"
  ON "ChannelConnection" ("channelType");

CREATE INDEX IF NOT EXISTS "ChannelConnection_isActive_idx"
  ON "ChannelConnection" ("isActive");

-- ── VariantChannelListing column drift fixes ────────────────────────
-- Each column below is described in schema.prisma but never made it
-- into a migration. Without these, the wired /api/sync/ebay/listings
-- and /api/sync/ebay/inventory endpoints crash with "column ... does
-- not exist" the first time they query.

ALTER TABLE "VariantChannelListing"
  ADD COLUMN IF NOT EXISTS "channelConnectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "externalListingId"   TEXT,
  ADD COLUMN IF NOT EXISTS "externalSku"         TEXT,
  ADD COLUMN IF NOT EXISTS "listingUrl"          TEXT,
  ADD COLUMN IF NOT EXISTS "currentPrice"        DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS "quantity"            INTEGER,
  ADD COLUMN IF NOT EXISTS "quantitySold"        INTEGER NOT NULL DEFAULT 0;

-- channelId was created as NOT NULL by the original Rithum architecture
-- migration but the schema describes it as nullable (since eBay rows
-- key off channelConnectionId, not the legacy Channel.id). Drop the
-- NOT NULL so creates() that omit channelId succeed. Existing rows are
-- already non-null so this is a one-way relaxation, no backfill needed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'VariantChannelListing'
      AND column_name = 'channelId'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "VariantChannelListing"
      ALTER COLUMN "channelId" DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "VariantChannelListing_channelConnectionId_idx"
  ON "VariantChannelListing" ("channelConnectionId");

CREATE INDEX IF NOT EXISTS "VariantChannelListing_externalListingId_idx"
  ON "VariantChannelListing" ("externalListingId");

-- Reattach the FK now that both sides exist. Wrapped in DO block so
-- re-runs don't error on the existing constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'VariantChannelListing_channelConnectionId_fkey'
      AND table_name = 'VariantChannelListing'
  ) THEN
    ALTER TABLE "VariantChannelListing"
      ADD CONSTRAINT "VariantChannelListing_channelConnectionId_fkey"
      FOREIGN KEY ("channelConnectionId")
      REFERENCES "ChannelConnection"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;
