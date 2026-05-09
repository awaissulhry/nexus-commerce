-- W1.10 — 10k SKU headroom: hot-path indexes on Product.
--
-- Audit on 2026-05-09 found 280 master products in this environment;
-- the user has committed to designing for 10k SKU headroom across the
-- enterprise PIM rebuild (Waves 1-5). At 280 rows none of these
-- indexes change query plans; at 10k+ they prevent sequential scans
-- on the hottest /products grid query paths.
--
-- Coverage:
--   - (status, deletedAt): "list active non-deleted products" — the
--     foundation of nearly every list query in /products and most
--     facet aggregations. Composite so a single B-tree lookup covers
--     both predicates without a bitmap merge.
--   - brand: facet filter (FilterBar; 1/280 brands today, but each
--     real-world Xavia ramp will multiply this count).
--   - productType: facet filter (FilterBar; 0/280 today — every
--     product needs a type for Wave 2 attribute set inheritance).
--   - parentId: hierarchy lookup (children-of-parent). Prisma does
--     NOT auto-index relation FK columns, so this would seq-scan as
--     parent count grows.
--   - isParent: cheap boolean facet for the Hierarchy lens.
--   - fulfillmentMethod: facet filter (FBA vs FBM split).
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-running the
-- migration on an environment that already has any of these indexes
-- (e.g., one created out-of-band) is a no-op.

CREATE INDEX IF NOT EXISTS "Product_status_deletedAt_idx"
  ON "Product"("status", "deletedAt");

CREATE INDEX IF NOT EXISTS "Product_brand_idx"
  ON "Product"("brand");

CREATE INDEX IF NOT EXISTS "Product_productType_idx"
  ON "Product"("productType");

CREATE INDEX IF NOT EXISTS "Product_parentId_idx"
  ON "Product"("parentId");

CREATE INDEX IF NOT EXISTS "Product_isParent_idx"
  ON "Product"("isParent");

CREATE INDEX IF NOT EXISTS "Product_fulfillmentMethod_idx"
  ON "Product"("fulfillmentMethod");
