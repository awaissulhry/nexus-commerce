-- W5.43 — two composite indexes to cover /products grid hot paths.
--
-- W5.12 perf-bench at 10k catalog (10,281 non-deleted rows) showed
-- two scenarios over the p95 < 100ms threshold:
--
--   default list (sort updatedAt DESC): p95 131ms
--   multi-sort brand/basePrice/sku:     p95 164ms
--
-- The W1.10 single-column indexes can't merge for multi-column
-- ORDER BY. Postgres bitmap-AND-scans for filtering but uses one
-- index for ordering. These composites carry the exact column
-- order the queries use.
--
-- Idempotent: IF NOT EXISTS guards skip if the index already
-- exists (e.g. on a partial-roll-back recovery).

CREATE INDEX IF NOT EXISTS "Product_parentId_deletedAt_updatedAt_idx"
  ON "Product" ("parentId", "deletedAt", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS "Product_brand_basePrice_sku_idx"
  ON "Product" ("brand", "basePrice" DESC, "sku");
