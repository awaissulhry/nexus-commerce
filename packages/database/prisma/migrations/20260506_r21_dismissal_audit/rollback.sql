-- Rollback R.21 dismissal audit columns. Reverting drops audit
-- history of any dismissals; if data is in production, prefer
-- migrating away from these columns rather than dropping.

ALTER TABLE "ReplenishmentRecommendation"
  DROP COLUMN IF EXISTS "dismissedAt",
  DROP COLUMN IF EXISTS "dismissedByUserId",
  DROP COLUMN IF EXISTS "dismissedReason";
