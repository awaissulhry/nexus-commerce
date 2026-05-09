-- Rollback for W2.1 — drop ProductFamily + Product.familyId.
-- Order: detach Product.familyId first (FK + col + idx), then drop
-- the ProductFamily table (which auto-drops its self-FK + idx).
-- IF EXISTS so partial-state rollbacks are safe.

ALTER TABLE "Product"
  DROP CONSTRAINT IF EXISTS "Product_familyId_fkey";

DROP INDEX IF EXISTS "Product_familyId_idx";

ALTER TABLE "Product"
  DROP COLUMN IF EXISTS "familyId";

DROP TABLE IF EXISTS "ProductFamily";
