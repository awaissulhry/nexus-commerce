-- PES.5 — listing ALIASES: N listings of one product on one channel x marketplace x account.
--
-- ── Why this exists ─────────────────────────────────────────────────────────
-- Measured on production 2026-09-01: `max(rows per (productId, channel,
-- marketplace, channelConnectionId))` = 1, enforced by the two unique indexes
-- below. That is exactly what makes a second eBay listing of the same product
-- impossible, so operators built one anyway — 22 `Product` rows with
-- productType='EBAY_LISTING_SHELL', each a phantom parent (basePrice 0, zero
-- children, no link back to the product it duplicates) holding one EBAY:IT
-- ChannelListing with a real ItemID. This migration gives those a home.
--
-- ── Why aliasId is NULLABLE ─────────────────────────────────────────────────
-- Both indexes are already declared NULLS NOT DISTINCT (MAP.2b, and prod runs
-- PostgreSQL 17.11 — measured). NULL therefore COLLIDES with NULL, so all 977
-- existing rows keep colliding on exactly the tuple they collide on today:
--
--   * zero backfill, zero data change, and nothing loosens for existing rows;
--   * NULL keeps a single, honest meaning — "the product's primary listing";
--   * no synthetic primary-alias row per coordinate (977 writes buying nothing).
--
-- A NOT NULL DEFAULT 'primary' discriminator was rejected for the opposite
-- reason: it needs every row rewritten to say what their absence already says.
--
-- ── ⚠ ADDITIVE ONLY — the old keys are NOT dropped here ─────────────────────
-- This is MAP.2b's hard-won lesson, and it applies verbatim. Prisma compiles a
-- compound-unique upsert to `INSERT … ON CONFLICT (<those exact columns>)`, and
-- ON CONFLICT requires an index matching the named columns exactly. A rolling
-- deploy serves the OLD container for a few seconds after migrations run, and
-- in that window every 4-column upsert would throw 42P10 if the 4-column index
-- were already gone. So both widths coexist for one release:
--
--   old container -> ON CONFLICT (4 cols) -> matches the OLD index   ok
--   new container -> ON CONFLICT (5 cols) -> matches the NEW index   ok
--
-- Both can hold at once: the 4-column index is strictly narrower, and while no
-- alias exists no write violates it.
--
-- ⚠ CONSEQUENCE: while the old indexes stand, INSERTing a second alias row for
-- a coordinate still violates them. Alias CREATION is therefore inert until
-- PES.5-ii drops them, which must ship in a LATER RELEASE than this one. Its
-- SQL is parked OUTSIDE prisma/migrations/ on purpose —
-- `prisma/migrations-pending/20260901d_pes5_ii_drop_legacy_alias_keys.sql` —
-- because `prisma migrate deploy` applies every folder it finds, which would
-- collapse the two releases into one and reintroduce the 42P10 window
-- (reference_migrate_deploy_drags_parked_migrations).
--
-- Index names are <= 63 characters on purpose: Postgres truncates silently past
-- that, and a truncated name is one nobody can drop by the name they wrote.
--
-- Rollback: rollback.sql beside this file. Reversible in full — nothing is
-- backfilled and no existing row is touched.

-- ── The alias itself ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProductListingAlias" (
  "id"                   TEXT NOT NULL,
  "productId"            TEXT NOT NULL,
  "channel"              TEXT NOT NULL,
  "marketplace"          TEXT NOT NULL,
  "channelConnectionId"  TEXT,
  "label"                TEXT NOT NULL,
  "position"             INTEGER NOT NULL DEFAULT 1,
  "status"               TEXT NOT NULL DEFAULT 'ACTIVE',
  "adoptedFromProductId" TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy"            TEXT,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductListingAlias_pkey" PRIMARY KEY ("id")
);

-- ON DELETE CASCADE: an alias is meaningless without its product.
ALTER TABLE "ProductListingAlias"
  DROP CONSTRAINT IF EXISTS "ProductListingAlias_productId_fkey";
ALTER TABLE "ProductListingAlias"
  ADD CONSTRAINT "ProductListingAlias_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE SET NULL, matching every other MAP.2a attribution FK: disconnecting
-- an account must lose attribution, never delete listings.
ALTER TABLE "ProductListingAlias"
  DROP CONSTRAINT IF EXISTS "ProductListingAlias_channelConnectionId_fkey";
ALTER TABLE "ProductListingAlias"
  ADD CONSTRAINT "ProductListingAlias_channelConnectionId_fkey"
  FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Two aliases on one coordinate cannot share a display position. NULLS NOT
-- DISTINCT so an unattributed connection still collides.
CREATE UNIQUE INDEX IF NOT EXISTS "ProductListingAlias_coord_position_key"
  ON "ProductListingAlias" ("productId", "channel", "marketplace", "channelConnectionId", "position")
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS "ProductListingAlias_productId_idx"           ON "ProductListingAlias" ("productId");
CREATE INDEX IF NOT EXISTS "ProductListingAlias_channel_marketplace_idx" ON "ProductListingAlias" ("channel", "marketplace");
CREATE INDEX IF NOT EXISTS "ProductListingAlias_channelConnectionId_idx" ON "ProductListingAlias" ("channelConnectionId");

-- ── The discriminator ───────────────────────────────────────────────────────
ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "aliasId" TEXT;

ALTER TABLE "ChannelListing" DROP CONSTRAINT IF EXISTS "ChannelListing_aliasId_fkey";
ALTER TABLE "ChannelListing"
  ADD CONSTRAINT "ChannelListing_aliasId_fkey"
  FOREIGN KEY ("aliasId") REFERENCES "ProductListingAlias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ChannelListing_aliasId_idx" ON "ChannelListing" ("aliasId");

-- ── The widened keys — BOTH of them ─────────────────────────────────────────
-- The legacy channelMarket key must widen too. Extending only the modern key
-- would leave this one still enforcing one listing per product per market,
-- which is the whole constraint being lifted.
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channelMarket_alias_key"
  ON "ChannelListing" ("productId", "channelMarket", "channelConnectionId", "aliasId")
  NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channel_marketplace_alias_key"
  ON "ChannelListing" ("productId", "channel", "marketplace", "channelConnectionId", "aliasId")
  NULLS NOT DISTINCT;
