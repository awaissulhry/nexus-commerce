ALTER TABLE "StockCostLayer"
  DROP CONSTRAINT IF EXISTS "StockCostLayer_vatRate_range";

ALTER TABLE "StockCostLayer"
  DROP COLUMN IF EXISTS "vatRate";

ALTER TABLE "StockCostLayer"
  DROP COLUMN IF EXISTS "unitCostVatExcluded";
