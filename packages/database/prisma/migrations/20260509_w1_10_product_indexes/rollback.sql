-- Rollback for W1.10 — drop the hot-path Product indexes.
-- IF EXISTS so it's safe to run when partial state was applied.

DROP INDEX IF EXISTS "Product_status_deletedAt_idx";
DROP INDEX IF EXISTS "Product_brand_idx";
DROP INDEX IF EXISTS "Product_productType_idx";
DROP INDEX IF EXISTS "Product_parentId_idx";
DROP INDEX IF EXISTS "Product_isParent_idx";
DROP INDEX IF EXISTS "Product_fulfillmentMethod_idx";
