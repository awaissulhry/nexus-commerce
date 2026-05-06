-- Rollback for R.8.

ALTER TABLE "ReplenishmentRecommendation"
  DROP COLUMN IF EXISTS "amazonRecommendedQty",
  DROP COLUMN IF EXISTS "amazonDeltaPct",
  DROP COLUMN IF EXISTS "amazonReportAsOf";

DROP TABLE IF EXISTS "FbaRestockRow";
DROP TABLE IF EXISTS "FbaRestockReport";
