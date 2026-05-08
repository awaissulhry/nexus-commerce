-- Rollback for S.16 ABC classification.
DROP INDEX IF EXISTS "Product_abcClass_idx";
ALTER TABLE "Product"
  DROP COLUMN IF EXISTS "abcClassUpdatedAt",
  DROP COLUMN IF EXISTS "abcClass";
