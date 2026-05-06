-- Rollback for R.19.

ALTER TABLE "ReplenishmentRecommendation"
  DROP COLUMN IF EXISTS "freightCostPerUnitCents",
  DROP COLUMN IF EXISTS "landedCostPerUnitCents";

DROP TABLE IF EXISTS "SupplierShippingProfile";
