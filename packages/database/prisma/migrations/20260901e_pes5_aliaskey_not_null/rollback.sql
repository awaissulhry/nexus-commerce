-- Rollback for 20260901e. Restores 20260901c's (unusable) aliasId-keyed indexes
-- and drops aliasKey.
-- ⚠ Only safe while no alias rows exist: two rows sharing a coordinate with
-- different aliasKeys would violate the restored keys. Check first:
--   SELECT count(*) FROM "ChannelListing" WHERE "aliasKey" <> '';
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channelMarket_alias_key"
  ON "ChannelListing" ("productId", "channelMarket", "channelConnectionId", "aliasId") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channel_marketplace_alias_key"
  ON "ChannelListing" ("productId", "channel", "marketplace", "channelConnectionId", "aliasId") NULLS NOT DISTINCT;
DROP INDEX IF EXISTS "ChannelListing_productId_channel_marketplace_akey_key";
DROP INDEX IF EXISTS "ChannelListing_productId_channelMarket_akey_key";
ALTER TABLE "ChannelListing" DROP COLUMN IF EXISTS "aliasKey";
