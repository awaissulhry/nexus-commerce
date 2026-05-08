-- Rollback for S.25 FbaInventoryDetail table.
DROP INDEX IF EXISTS "FbaInventoryDetail_firstReceivedAt_idx";
DROP INDEX IF EXISTS "FbaInventoryDetail_condition_idx";
DROP INDEX IF EXISTS "FbaInventoryDetail_fulfillmentCenterId_idx";
DROP INDEX IF EXISTS "FbaInventoryDetail_marketplaceId_idx";
DROP INDEX IF EXISTS "FbaInventoryDetail_productId_idx";
DROP INDEX IF EXISTS "FbaInventoryDetail_sku_market_fc_condition_unique_idx";
DROP TABLE IF EXISTS "FbaInventoryDetail";
