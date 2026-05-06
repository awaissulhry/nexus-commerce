-- Rollback for R.11 lead-time variance
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "leadTimeStdDevDays";

ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "leadTimeStatsUpdatedAt";
ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "leadTimeSampleCount";
ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "leadTimeStdDevDays";
