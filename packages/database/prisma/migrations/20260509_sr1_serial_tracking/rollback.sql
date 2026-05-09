ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_serialNumberId_fkey";
DROP INDEX IF EXISTS "StockMovement_serialNumberId_idx";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "serialNumberId";
DROP TABLE IF EXISTS "SerialNumber";
