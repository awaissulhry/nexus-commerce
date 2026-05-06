-- Rollback for R.6 auto-PO trigger
DROP TABLE IF EXISTS "AutoPoRunLog";

ALTER TABLE "ReplenishmentRule" DROP COLUMN IF EXISTS "autoTriggerEnabled";

ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "autoTriggerMaxCostCentsPerPo";
ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "autoTriggerMaxQtyPerPo";
ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "autoTriggerEnabled";
