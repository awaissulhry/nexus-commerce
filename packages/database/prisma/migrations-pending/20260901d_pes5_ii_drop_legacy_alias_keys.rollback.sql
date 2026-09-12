-- Rollback for PES.5-ii. Recreates the pre-alias 4-column unique indexes.
-- ⚠ This FAILS if any alias rows exist, because two rows sharing a coordinate
-- with different aliasIds violate the narrow key. That is correct: it means the
-- alias feature is in use and cannot be rolled back by index alone. Check with:
--   SELECT count(*) FROM "ChannelListing" WHERE "aliasId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channelMarket_conn_key"
  ON "ChannelListing" ("productId", "channelMarket", "channelConnectionId") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channel_marketplace_conn_key"
  ON "ChannelListing" ("productId", "channel", "marketplace", "channelConnectionId") NULLS NOT DISTINCT;
