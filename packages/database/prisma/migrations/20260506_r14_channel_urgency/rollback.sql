-- Rollback for R.14 channel urgency fields
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "worstChannelDaysOfCover";
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "worstChannelKey";
ALTER TABLE "ReplenishmentRecommendation" DROP COLUMN IF EXISTS "urgencySource";
