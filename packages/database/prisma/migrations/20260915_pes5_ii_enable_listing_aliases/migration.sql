-- The account/alias-aware writers have been deployed since September 1.
-- Finish the deferred PES.5 cutover. Preserve uniqueness for unattributed
-- listings as well: workspace isolation recreated these indexes without
-- NULLS NOT DISTINCT, while channelConnectionId is still nullable.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF NOT pg_try_advisory_xact_lock(72707369) THEN
    RAISE EXCEPTION 'Another schema migration holds the migration lock';
  END IF;
END $$;
LOCK TABLE "ChannelListing" IN SHARE ROW EXCLUSIVE MODE;
DROP INDEX "ChannelListing_productId_channelMarket_akey_key";
DROP INDEX "ChannelListing_productId_channel_marketplace_akey_key";
CREATE UNIQUE INDEX "ChannelListing_productId_channelMarket_akey_key"
  ON "ChannelListing" ("workspaceId", "productId", "channelMarket", "channelConnectionId", "aliasKey") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "ChannelListing_productId_channel_marketplace_akey_key"
  ON "ChannelListing" ("workspaceId", "productId", "channel", "marketplace", "channelConnectionId", "aliasKey") NULLS NOT DISTINCT;
DROP INDEX IF EXISTS "ChannelListing_productId_channelMarket_conn_key";
DROP INDEX IF EXISTS "ChannelListing_productId_channel_marketplace_conn_key";
COMMIT;
