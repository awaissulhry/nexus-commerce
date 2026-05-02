-- Rollback for P0 #31 ChannelConnection migration.

ALTER TABLE "VariantChannelListing"
  DROP CONSTRAINT IF EXISTS "VariantChannelListing_channelConnectionId_fkey";

DROP INDEX IF EXISTS "VariantChannelListing_channelConnectionId_idx";
DROP INDEX IF EXISTS "VariantChannelListing_externalListingId_idx";

ALTER TABLE "VariantChannelListing"
  DROP COLUMN IF EXISTS "channelConnectionId",
  DROP COLUMN IF EXISTS "externalListingId",
  DROP COLUMN IF EXISTS "externalSku",
  DROP COLUMN IF EXISTS "listingUrl",
  DROP COLUMN IF EXISTS "currentPrice",
  DROP COLUMN IF EXISTS "quantity",
  DROP COLUMN IF EXISTS "quantitySold";

-- Note: not restoring NOT NULL on channelId because doing so requires
-- backfill if any nullable rows were inserted post-migration.

DROP TABLE IF EXISTS "ChannelConnection";
