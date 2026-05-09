ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_binId_fkey";
DROP INDEX IF EXISTS "StockMovement_binId_idx";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "binId";
DROP TABLE IF EXISTS "StockBinQuantity";
DROP TABLE IF EXISTS "StockBin";
