-- C (TOS-IS) — store Amazon's true Top-of-Search impression share per
-- campaign-day on the TOP_OF_SEARCH placement row. Additive nullable column;
-- existing rows and the placements ingest are unaffected.
ALTER TABLE "AmazonAdsPlacementReport"
  ADD COLUMN IF NOT EXISTS "topOfSearchIS" DECIMAL(8,4);
