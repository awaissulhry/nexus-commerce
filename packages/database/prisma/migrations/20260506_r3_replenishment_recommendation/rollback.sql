-- Rollback for R.3 replenishment recommendation
DROP INDEX IF EXISTS "ReplenishmentRecommendation_one_active_per_product";
DROP TABLE IF EXISTS "ReplenishmentRecommendation";
