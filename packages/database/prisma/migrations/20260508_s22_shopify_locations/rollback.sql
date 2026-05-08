-- Rollback for S.22 Shopify Locations multi-location binding.
DROP INDEX IF EXISTS "StockLocation_externalChannel_externalLocationId_unique_idx";
DROP INDEX IF EXISTS "StockLocation_externalChannel_externalLocationId_idx";
ALTER TABLE "StockLocation"
  DROP COLUMN IF EXISTS "externalChannel",
  DROP COLUMN IF EXISTS "externalLocationId";
