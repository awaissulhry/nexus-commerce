-- MA.1: offerActive flag on ChannelListing
-- Controls whether a product's offer is active in a given channel+marketplace.
-- false = operator has paused selling here (preserves listing data for quick reactivation).
ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "offerActive" BOOLEAN NOT NULL DEFAULT true;
