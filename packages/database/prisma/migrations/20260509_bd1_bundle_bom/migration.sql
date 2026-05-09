-- BD.1 — Mark Product as a bundle.
--
-- The Bundle + BundleComponent tables already exist in the schema
-- (catalog-level bundle metadata). This migration adds the
-- Product.isBundle flag so the inventory consume path can detect
-- bundle products and fan out to component decrements via the
-- existing BundleComponent rows.
--
-- Idempotent: IF NOT EXISTS guards so re-runs are safe.

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "isBundle" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS "Product_isBundle_idx"
  ON "Product"("isBundle") WHERE "isBundle" = TRUE;
