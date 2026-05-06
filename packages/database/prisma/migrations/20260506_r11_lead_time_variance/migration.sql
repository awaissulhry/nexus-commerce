-- =====================================================================
-- R.11 — Lead-time variance in safety stock
--
-- Adds observed σ_LT to Supplier (computed nightly from PO history)
-- and persists the σ_LT used at recommendation time on the audit row.
-- =====================================================================

ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "leadTimeStdDevDays"     DECIMAL(8,2);
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "leadTimeSampleCount"    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "leadTimeStatsUpdatedAt" TIMESTAMP(3);

ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "leadTimeStdDevDays" DECIMAL(8,2);
