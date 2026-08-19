-- Rollback for 20260819c_map2b_ii_drop_legacy_keys.
--
-- ⚠ Read this before running it. These indexes are NARROWER than the four-column
-- keys that replaced them. If a second account has written any listing, recreating
-- them fails with a duplicate-key error — correctly. That failure is the signal
-- that the data has moved past this rollback: real multi-account rows exist, and
-- they must be reconciled or removed before a single-account constraint can hold
-- again. Do not force it.
--
-- Restoring these also re-imposes the constraint that BLOCKS a second account's
-- listings, which is the point of the rollback but is worth stating plainly.

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channelMarket_key"
  ON "ChannelListing" ("productId", "channelMarket");
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelListing_productId_channel_marketplace_key"
  ON "ChannelListing" ("productId", "channel", "marketplace");
CREATE UNIQUE INDEX IF NOT EXISTS "VariantChannelListing_variantId_channel_marketplace_key"
  ON "VariantChannelListing" ("variantId", "channel", "marketplace");
CREATE UNIQUE INDEX IF NOT EXISTS "SyncChannelPolicy_channel_marketplace_key"
  ON "SyncChannelPolicy" ("channel", "marketplace");
