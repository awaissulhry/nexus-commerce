-- W5.43 rollback — drop the two composites added by migration.sql.
-- Indexes are pure-additive; dropping them returns the catalog to
-- the W1.10 baseline (default list + multi-sort fall back to
-- single-column index plans + sort steps).

DROP INDEX IF EXISTS "Product_parentId_deletedAt_updatedAt_idx";
DROP INDEX IF EXISTS "Product_brand_basePrice_sku_idx";
