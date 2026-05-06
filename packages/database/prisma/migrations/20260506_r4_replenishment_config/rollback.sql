-- Rollback for R.4 replenishment config
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "unitCostCents";
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "constraintsApplied";
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "eoqUnits";
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "safetyStockUnits";

ALTER TABLE "Product" DROP COLUMN IF EXISTS "carryingCostPctYear";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "orderingCostCents";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "serviceLevelPercent";

ALTER TABLE "SupplierProduct" DROP COLUMN IF EXISTS "casePack";
