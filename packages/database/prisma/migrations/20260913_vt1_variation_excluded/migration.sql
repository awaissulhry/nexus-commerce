-- The variation controls use this column through raw SQL; retain every existing listing.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" BOOLEAN NOT NULL DEFAULT false;
COMMIT;
