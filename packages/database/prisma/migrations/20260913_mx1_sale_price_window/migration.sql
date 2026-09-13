-- MX.1 (D-MX4, 2026-09-13): the per-listing SALE WINDOW. Additive, nullable, no data rewrite, no index.
-- Amazon's Listings-Items schema schedules a sale as discounted_price.schedule[]{ start_at, end_at, value_with_tax }
-- (all three required, date-precision); the window is inclusive on both ends. DATE, not TIMESTAMP: a sale day is a
-- calendar day on the marketplace, and a timestamp would shift across the operator's time zone on read-back.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE;
ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;
COMMIT;
