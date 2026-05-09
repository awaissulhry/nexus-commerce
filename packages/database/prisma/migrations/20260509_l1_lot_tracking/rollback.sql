ALTER TABLE "StockCostLayer" DROP CONSTRAINT IF EXISTS "StockCostLayer_lotId_fkey";
DROP INDEX IF EXISTS "StockCostLayer_lotId_idx";
ALTER TABLE "StockCostLayer" DROP COLUMN IF EXISTS "lotId";

ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_lotId_fkey";
DROP INDEX IF EXISTS "StockMovement_lotId_idx";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "lotId";

DROP TABLE IF EXISTS "Lot";
