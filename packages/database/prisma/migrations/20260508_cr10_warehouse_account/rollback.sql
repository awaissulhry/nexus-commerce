-- ROLLBACK for 20260508_cr10_warehouse_account
ALTER TABLE "Warehouse" DROP CONSTRAINT IF EXISTS "Warehouse_defaultCarrierAccountId_fkey";
DROP INDEX IF EXISTS "Warehouse_defaultCarrierAccountId_idx";
ALTER TABLE "Warehouse" DROP COLUMN IF EXISTS "defaultCarrierAccountId";
