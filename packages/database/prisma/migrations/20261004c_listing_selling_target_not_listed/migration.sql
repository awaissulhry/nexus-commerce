-- New listings (2026-10-04; plan docs/sheet-publish-parity/PLAN.md, "NEW LISTINGS — control before the first publish").
--
-- A listing row NOT on the channel yet chooses in the Status column what Publish creates it as — Active or Inactive —
-- or that Publish leaves it out: Not listed (`@nexus/shared/listing-actions` NEW_LISTING_TARGETS). The choice waits on
-- the row like every Status value (`ChannelListing.sellingTarget`, migration 20261004b), so the column's CHECK gains one
-- word: NOT_LISTED.
--
-- Widening only: every value the constraint allowed is still allowed, no row is read differently or rewritten, and code
-- that does not know NOT_LISTED reads it as "nothing waiting". The constraint is replaced NOT VALID and then validated, so
-- the table is never locked for a full scan while writes wait. Idempotent: it can run twice.

ALTER TABLE "ChannelListing" DROP CONSTRAINT IF EXISTS "ChannelListing_sellingTarget_check";
ALTER TABLE "ChannelListing" ADD CONSTRAINT "ChannelListing_sellingTarget_check"
  CHECK ("sellingTarget" IS NULL OR "sellingTarget" IN ('ACTIVE', 'INACTIVE', 'ENDED', 'NOT_LISTED')) NOT VALID;
ALTER TABLE "ChannelListing" VALIDATE CONSTRAINT "ChannelListing_sellingTarget_check";
