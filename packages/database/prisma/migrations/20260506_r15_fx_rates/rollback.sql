-- Rollback for R.15 FX audit columns
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "fxRateUsed";
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "unitCostCurrency";
