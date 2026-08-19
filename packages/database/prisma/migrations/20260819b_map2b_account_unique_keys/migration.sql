-- MAP.2b — the unique keys gain the account dimension.
--
-- Deferred out of MAP.2a for a measured reason (see that migration's SCOPE note):
-- Prisma compiles a compound-unique `upsert` to `INSERT … ON CONFLICT (<those
-- exact columns>)`, and `ON CONFLICT` requires an index matching the named columns
-- exactly. MAP.2a's first draft used expression indexes (`COALESCE(...)`), which
-- cannot match — dropping the old keys then would have failed at RUNTIME with
-- 42P10 on 24 call sites, not at compile time.
--
-- ── What changed the answer: NULLS NOT DISTINCT ──────────────────────────────
-- Prod runs PostgreSQL 17.10 (measured). Since 15, a unique index can be declared
-- `NULLS NOT DISTINCT`, which makes NULL collide with NULL instead of the default
-- "every NULL is unique". That gives all three properties at once:
--
--   • the column list is plain, so `ON CONFLICT (a,b,c,d)` matches it and every
--     existing Prisma upsert keeps working;
--   • Prisma can express it as a normal `@@unique`, so the client types carry the
--     compound key and the compiler forces every caller to name the account;
--   • an unattributed row still collides exactly as it does today, so nothing
--     loosens for data no writer has reached yet.
--
-- The alternative was `channelConnectionId NOT NULL`. Rejected: it would block an
-- INSERT for any channel with no active connection — a Shopify ChannelListing
-- created before Shopify is connected, say. Measured today there are none
-- (977/977 attributed, and no channel has listings without a live connection), but
-- a constraint that depends on that staying true is a trap, not a guarantee.
--
-- Index names are ≤63 characters on purpose: Postgres truncates silently past
-- that, and a truncated name is one nobody can drop by the name they wrote.
--
-- ── ⚠ ADDITIVE ONLY — the old keys are NOT dropped here ──────────────────────
-- Proven in the dry-run: with the old three-column index gone,
-- `ON CONFLICT ("productId","channel","marketplace")` fails with **42P10**. A
-- rolling deploy serves the OLD container for a few seconds after the migration
-- has run, and in that window every three-column upsert would throw. So both keys
-- coexist for one release:
--
--   old container -> ON CONFLICT (3 cols) -> matches the OLD index   ✓
--   new container -> ON CONFLICT (4 cols) -> matches the NEW index   ✓
--
-- Both indexes can hold at once: the three-column one is strictly narrower, and
-- with a single account no write violates it. **MAP.2b-ii drops the old keys**,
-- and must land before MAP.4 connects a second account — until it does, the old
-- index is still what stops a second account's listing from being written.
--
-- Rollback: rollback.sql beside this file.

-- ── ChannelListing — BOTH keys ───────────────────────────────────────────────
-- The legacy channelMarket key ("EBAY_DE") must widen too. Extending only the
-- modern key would leave this one still enforcing one listing per product per
-- market across all accounts, which is the whole constraint being lifted.
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channelMarket_conn_key"
  ON "ChannelListing" ("productId", "channelMarket", "channelConnectionId")
  NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channel_marketplace_conn_key"
  ON "ChannelListing" ("productId", "channel", "marketplace", "channelConnectionId")
  NULLS NOT DISTINCT;

-- ── VariantChannelListing ────────────────────────────────────────────────────
-- (variantId, channelId) is deliberately left alone: channelId is a legacy
-- nullable Channel FK on a different axis, not an account.
CREATE UNIQUE INDEX IF NOT EXISTS "VariantChannelListing_variantId_channel_marketplace_conn_key"
  ON "VariantChannelListing" ("variantId", "channel", "marketplace", "channelConnectionId")
  NULLS NOT DISTINCT;

-- ── SyncChannelPolicy ────────────────────────────────────────────────────────
-- Without the account dimension here, an account-level sync pause is impossible:
-- pausing eBay would pause every eBay account at once.
CREATE UNIQUE INDEX IF NOT EXISTS "SyncChannelPolicy_channel_marketplace_conn_key"
  ON "SyncChannelPolicy" ("channel", "marketplace", "channelConnectionId")
  NULLS NOT DISTINCT;

-- Order.(channel, channelOrderId) and SharedListingMembership.(marketplace,
-- itemId, sku) stay as they are: marketplace order ids and eBay ItemIDs are
-- globally unique, so those keys survive multi-account unchanged. They gained
-- attribution in MAP.2a, which is all they needed.
