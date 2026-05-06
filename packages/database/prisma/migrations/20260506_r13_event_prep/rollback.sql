-- Rollback for R.13 event prep
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "prepExtraUnits";
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "prepEventId";
ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "autoTriggerEventPrep";
