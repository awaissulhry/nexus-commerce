-- Rollback for 20260819b_map2b_account_unique_keys.
--
-- The forward migration is ADDITIVE — it only CREATEs indexes, it drops nothing —
-- so the rollback is a plain drop of what it added. The original three-column keys
-- were never removed and need no restoring.
--
-- Safe to run at any time: the old keys still enforce single-account uniqueness on
-- their own, so dropping these leaves the database exactly as MAP.2a left it.

DROP INDEX IF EXISTS "ChannelListing_productId_channelMarket_conn_key";
DROP INDEX IF EXISTS "ChannelListing_productId_channel_marketplace_conn_key";
DROP INDEX IF EXISTS "VariantChannelListing_variantId_channel_marketplace_conn_key";
DROP INDEX IF EXISTS "SyncChannelPolicy_channel_marketplace_conn_key";
