-- BE.1 — bulk-edit lock flag on ListingImage.
-- Additive: NOT NULL with a default, so existing rows backfill to false.
ALTER TABLE "ListingImage" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;
