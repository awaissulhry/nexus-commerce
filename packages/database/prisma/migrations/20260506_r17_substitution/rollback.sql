-- Rollback for R.17 substitution
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "substitutionAdjustedDelta";
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "rawVelocity";
DROP TABLE IF EXISTS "ProductSubstitution";
