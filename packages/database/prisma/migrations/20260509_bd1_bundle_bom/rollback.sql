DROP INDEX IF EXISTS "Product_isBundle_idx";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "isBundle";
DROP TABLE IF EXISTS "BundleComponent";
