ALTER TABLE "StockCostLayer"
  DROP CONSTRAINT IF EXISTS "StockCostLayer_currency_rate_consistency";

ALTER TABLE "StockCostLayer"
  DROP COLUMN IF EXISTS "exchangeRateOnReceive";

ALTER TABLE "StockCostLayer"
  DROP COLUMN IF EXISTS "costCurrency";
