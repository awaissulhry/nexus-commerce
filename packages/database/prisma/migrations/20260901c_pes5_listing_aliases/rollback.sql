-- Rollback for 20260901c_pes5_listing_aliases.
-- Safe in full: the forward migration backfills nothing and rewrites no row, so
-- dropping the additions restores the exact prior state.
--
-- ⚠ Run this ONLY while the 4-column indexes still exist (i.e. PES.5-ii has NOT
-- run). If PES.5-ii already dropped them, restore those first —
-- prisma/migrations-pending/20260901d_pes5_ii_drop_legacy_alias_keys.rollback.sql —
-- or every ChannelListing upsert loses its ON CONFLICT target and throws 42P10.
--
-- ⚠ Dropping "ProductListingAlias" CASCADEs to any ChannelListing row that
-- points at an alias, i.e. every non-primary listing. Check before running:
--   SELECT count(*) FROM "ChannelListing" WHERE "aliasId" IS NOT NULL;
-- A non-zero count means real listing rows will be deleted.

DROP INDEX IF EXISTS "ChannelListing_productId_channel_marketplace_alias_key";
DROP INDEX IF EXISTS "ChannelListing_productId_channelMarket_alias_key";
DROP INDEX IF EXISTS "ChannelListing_aliasId_idx";

ALTER TABLE "ChannelListing" DROP CONSTRAINT IF EXISTS "ChannelListing_aliasId_fkey";
ALTER TABLE "ChannelListing" DROP COLUMN IF EXISTS "aliasId";

DROP TABLE IF EXISTS "ProductListingAlias";
