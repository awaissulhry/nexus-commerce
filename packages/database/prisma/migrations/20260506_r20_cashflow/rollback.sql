-- Rollback for R.20.

ALTER TABLE "BrandSettings" DROP COLUMN IF EXISTS "cashOnHandCents";
