-- Rollback for S.20 cost layers.
-- Drops the new table + the additive Product/StockMovement columns.
DROP INDEX IF EXISTS "StockCostLayer_stockMovementId_idx";
DROP INDEX IF EXISTS "StockCostLayer_inboundShipmentId_idx";
DROP INDEX IF EXISTS "StockCostLayer_productId_unitsRemaining_idx";
DROP INDEX IF EXISTS "StockCostLayer_productId_receivedAt_idx";
DROP TABLE IF EXISTS "StockCostLayer";

ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "cogsCents";

ALTER TABLE "Product"
  DROP COLUMN IF EXISTS "weightedAvgCostCents",
  DROP COLUMN IF EXISTS "costingMethod";
