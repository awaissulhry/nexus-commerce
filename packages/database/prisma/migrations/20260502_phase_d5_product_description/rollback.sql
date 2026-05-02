-- Rollback for D.5: drop the master-level description column.
ALTER TABLE "Product"
  DROP COLUMN IF EXISTS "description";
