-- =====================================================================
-- H.2: Unify ChannelConnection schema (Phase 1 — additive)
--
-- Make ChannelConnection channel-agnostic so Amazon (env-managed) and
-- future Shopify/Woo/Etsy OAuth grants can store credentials in a
-- single table. Today the eBay-specific columns force every connector
-- to invent its own storage location (env vars for Amazon, the unused
-- MarketplaceCredential table, the unused Channel.credentials column).
--
-- Phase 1 of a two-step rename:
--   - This migration adds GENERIC columns alongside the legacy ebay*
--     columns and backfills generic from legacy for existing rows.
--   - Code in the same release dual-writes to both columns. After at
--     least one release, a follow-up migration drops the legacy
--     ebay* columns once all callers have migrated.
--
-- Pre-flight: NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON must be set to 0
-- on Railway BEFORE this migration runs. The cron writes to legacy
-- ebay* columns; running it concurrently with the backfill UPDATE
-- could produce a row where legacy is fresh but generic is stale
-- (the backfill UPDATE doesn't take a row lock long enough to block
-- a concurrent UPDATE from the cron — they'd interleave).
-- =====================================================================

-- ── 1. Add generic columns to ChannelConnection ─────────────────────
-- Each column is nullable except `managedBy`, which has a sensible
-- default ('oauth') so existing rows backfill in step 2 can be
-- selective rather than blanket-update every row.
ALTER TABLE "ChannelConnection"
  ADD COLUMN "marketplace"    TEXT,
  ADD COLUMN "managedBy"      TEXT NOT NULL DEFAULT 'oauth',
  ADD COLUMN "accessToken"    TEXT,
  ADD COLUMN "refreshToken"   TEXT,
  ADD COLUMN "tokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "displayName"    TEXT;

-- ── 2. Backfill generic columns from legacy ebay* for existing rows ──
-- Idempotent — re-running this UPDATE simply re-copies whatever is
-- currently in legacy. Only applies to channelType=EBAY rows because
-- those are the only rows with legacy data today. The synthetic
-- Amazon row (managedBy='env', channelType='AMAZON') is created at
-- runtime by seedEnvManagedConnections() in the API startup path —
-- not by this migration.
UPDATE "ChannelConnection" SET
  "accessToken"    = "ebayAccessToken",
  "refreshToken"   = "ebayRefreshToken",
  "tokenExpiresAt" = "ebayTokenExpiresAt",
  "displayName"    = "ebaySignInName",
  "managedBy"      = 'oauth'
WHERE "channelType" = 'EBAY';

-- ── 3. Indexes ──────────────────────────────────────────────────────
CREATE INDEX "ChannelConnection_managedBy_idx"
  ON "ChannelConnection"("managedBy");

-- Partial unique: at most one ACTIVE connection per (channelType,
-- marketplace). Multiple inactive rows are allowed — they're revoked
-- grants we keep for audit. Postgres native UNIQUE doesn't accept
-- WHERE, so we use a partial unique index. Prisma's schema.prisma
-- can't represent this natively; the schema-drift gate accepts the
-- discrepancy because it only verifies CREATE TABLE presence per
-- model, not index parity.
--
-- NULL marketplace is permitted: eBay grants are multi-marketplace
-- under a single token, so eBay rows have marketplace=NULL. Postgres
-- treats two NULLs as not-equal in a UNIQUE index, which would let
-- two active eBay rows slip through. The audit on 2026-05-06 verified
-- there are 0 such duplicates today; if a re-OAuth ever creates one,
-- the application logic in ebay-auth.service.ts must mark the old
-- row inactive before inserting the new one (today's flow already
-- does this via the UI revoke path).
CREATE UNIQUE INDEX "ChannelConnection_channelType_marketplace_active_key"
  ON "ChannelConnection" ("channelType", "marketplace")
  WHERE "isActive" = true;

-- ── 4. Drop unused MarketplaceCredential table ──────────────────────
-- Audited 2026-05-06: 0 rows, never referenced in any service code.
-- Designed for SHOPIFY/WOOCOMMERCE/ETSY but those services read
-- process.env directly. ChannelConnection is now the single home
-- for connector credentials.
DROP TABLE "MarketplaceCredential";

-- ── 5. Drop unused Channel.credentials column ───────────────────────
-- Audited 2026-05-06: Channel table has 0 rows, and the credentials
-- column (TEXT NOT NULL, AES-256-GCM-encrypted blob per the schema
-- comment) was never written to or read from any service. The Channel
-- table itself stays as a lookup target for Listing.channelId.
ALTER TABLE "Channel" DROP COLUMN "credentials";
