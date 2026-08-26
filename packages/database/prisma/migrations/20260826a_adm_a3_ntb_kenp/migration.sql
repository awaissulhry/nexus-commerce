-- ADM-A3 — new-to-brand units/rate and Kindle Edition Normalized Pages.
--
-- These columns were empty on the Ad Manager not because Amazon withholds them but because
-- CAMPAIGN_COLUMNS never requested them. Verified 2026-08-26 by asking the v3 report API directly
-- (an invalid column name makes it return its allowed list per ad product):
--   SPONSORED_BRANDS  offers 14 newToBrand columns
--   SPONSORED_DISPLAY offers 11 (base counts only — no *Percentage / *Rate)
--   SPONSORED_PRODUCTS offers NONE, but does offer the two KENP columns below
--
-- Deliberately NULLABLE with NO DEFAULT. The two pre-existing NTB columns carry `DEFAULT 0`, and
-- that default is exactly what let "we never asked Amazon" render as a measured zero on 6,045 rows.
-- NULL here means "this ad product's report does not carry it"; 0 will mean a real reported zero.
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "ntbUnits14d" INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "ntbOrdersRate14d" DOUBLE PRECISION;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "kenpRead14d" INTEGER;
ALTER TABLE "AmazonAdsDailyPerformance" ADD COLUMN IF NOT EXISTS "kenpRoyaltiesCents14d" INTEGER;
