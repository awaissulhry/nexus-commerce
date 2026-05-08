-- F.1 — soft delete on Product.
--
-- Adds Product.deletedAt (nullable timestamp) plus an index on it so
-- the default list filter (`WHERE "deletedAt" IS NULL`) is fast on the
-- ~3.2k row catalog and on growth past that.
--
-- The column is nullable + NULL-by-default, so existing rows stay
-- visible without a backfill. New rows from create-wizard / bulk
-- import inherit NULL implicitly.
--
-- Restoration is a normal UPDATE setting deletedAt back to NULL; no
-- separate `restoredAt` column — audit trail goes through AuditLog.

ALTER TABLE "Product" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Product_deletedAt_idx" ON "Product"("deletedAt");
