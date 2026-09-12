-- PES.5-ii — drop the pre-alias 4-column unique indexes.
--
-- ⚠ MUST ship in a LATER RELEASE than 20260901c_pes5_listing_aliases.
--
-- 20260901c added the 5-column (…, "aliasId") indexes and deliberately left the
-- 4-column ones in place, so that during a rolling deploy the OLD container's
-- `ON CONFLICT (4 cols)` still matches an index. Once every running container
-- emits 5 columns, the narrow indexes are pure obstruction: they still enforce
-- one listing per product per coordinate, which is what blocks a second alias.
--
-- Until this runs, alias CREATION cannot succeed — an INSERT of a second row for
-- a coordinate violates the old index even though the new one permits it.
--
-- Verify before running (expect: every container on the new build):
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ChannelListing'
--     AND indexname LIKE '%alias_key';        -- both 5-column indexes present
--
-- Rollback: 20260901d_pes5_ii_drop_legacy_alias_keys.rollback.sql

DROP INDEX IF EXISTS "ChannelListing_productId_channelMarket_conn_key";
DROP INDEX IF EXISTS "ChannelListing_productId_channel_marketplace_conn_key";
