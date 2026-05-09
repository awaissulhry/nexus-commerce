DROP INDEX IF EXISTS "StockReservation_kind_idx";
ALTER TABLE "StockReservation" DROP CONSTRAINT IF EXISTS "StockReservation_kind_valid";
ALTER TABLE "StockReservation" DROP COLUMN IF EXISTS "kind";
