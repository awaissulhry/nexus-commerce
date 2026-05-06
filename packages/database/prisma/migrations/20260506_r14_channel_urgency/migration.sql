-- =====================================================================
-- R.14 — Channel-level urgency promotion audit fields
--
-- Adds three nullable columns to ReplenishmentRecommendation so we
-- can answer "why was this CRITICAL?" on a row in the audit trail.
-- urgencySource = 'GLOBAL' (aggregate velocity vs effective stock)
-- or 'CHANNEL' (a specific channel-marketplace was running on
-- empty even though the aggregate looked fine).
-- =====================================================================

ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "urgencySource"           TEXT;
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "worstChannelKey"         TEXT;
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "worstChannelDaysOfCover" INTEGER;
