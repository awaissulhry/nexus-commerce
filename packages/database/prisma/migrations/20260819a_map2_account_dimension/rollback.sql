-- Rollback for 20260819a_map2_account_dimension.
--
-- Restores every unique key this migration replaced, then removes what it added.
-- Idempotent throughout, so a partial rollback can be re-run.
--
-- ⚠ Run the index restores FIRST and read the output. Each original key is narrower
-- than its replacement, so if a second account has already written rows, the
-- CREATE UNIQUE INDEX will fail with a duplicate-key error — correctly. That failure
-- is the signal that the data has moved past this rollback: it means real
-- multi-account rows exist, and they must be reconciled (or deleted) before the
-- single-account constraints can hold again. Do not force it.

-- ── Restore the original unique keys ─────────────────────────────────────────
DROP INDEX IF EXISTS "ChannelConnection_active_account_key";
DROP INDEX IF EXISTS "ChannelConnection_channelType_primary_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelConnection_channelType_marketplace_active_key"
  ON "ChannelConnection" ("channelType", "marketplace") WHERE "isActive" = true;

-- ChannelListing / VariantChannelListing / SyncChannelPolicy keys are NOT restored
-- here: MAP.2a never dropped them (see the SCOPE note in migration.sql). They widen
-- in MAP.2b, which carries its own rollback.

-- ── Remove the foreign keys and indexes added in §5 ──────────────────────────
ALTER TABLE "ChannelListing"          DROP CONSTRAINT IF EXISTS "ChannelListing_channelConnectionId_fkey";
ALTER TABLE "SharedListingMembership" DROP CONSTRAINT IF EXISTS "SharedListingMembership_channelConnectionId_fkey";
ALTER TABLE "Order"                   DROP CONSTRAINT IF EXISTS "Order_channelConnectionId_fkey";
ALTER TABLE "SyncChannelPolicy"       DROP CONSTRAINT IF EXISTS "SyncChannelPolicy_channelConnectionId_fkey";

DROP INDEX IF EXISTS "ChannelListing_channelConnectionId_idx";
DROP INDEX IF EXISTS "SharedListingMembership_channelConnectionId_idx";
DROP INDEX IF EXISTS "Order_channelConnectionId_idx";
DROP INDEX IF EXISTS "SyncChannelPolicy_channelConnectionId_idx";

-- ── Remove the added columns ─────────────────────────────────────────────────
-- VariantChannelListing.channelConnectionId is NOT dropped: it predates MAP.2
-- (E.1/C.14) and is not this migration's to remove. Its backfilled values are left
-- in place for the same reason — on a table that held 0 rows at migration time.
ALTER TABLE "ChannelListing"          DROP COLUMN IF EXISTS "channelConnectionId";
ALTER TABLE "SharedListingMembership" DROP COLUMN IF EXISTS "channelConnectionId";
ALTER TABLE "Order"                   DROP COLUMN IF EXISTS "channelConnectionId";
ALTER TABLE "SyncChannelPolicy"       DROP COLUMN IF EXISTS "channelConnectionId";

ALTER TABLE "ChannelConnection" DROP COLUMN IF EXISTS "accountLabel";
ALTER TABLE "ChannelConnection" DROP COLUMN IF EXISTS "accountColor";
ALTER TABLE "ChannelConnection" DROP COLUMN IF EXISTS "isPrimary";
ALTER TABLE "ChannelConnection" DROP COLUMN IF EXISTS "sortOrder";
ALTER TABLE "ChannelConnection" DROP COLUMN IF EXISTS "externalAccountId";
