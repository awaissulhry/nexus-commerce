-- Phase K.7 — per-category GTIN exemption
--
-- Amazon's GTIN-exemption grant is per (brand, productType). The
-- existing GtinExemptionApplication table only carried (brand,
-- marketplace), so two products of the same brand but different
-- categories couldn't have independent exemption status. Adding
-- a nullable productType column closes the gap.
--
-- Nullable for backwards compat: existing rows have productType=NULL
-- meaning "covers any category for this brand+marketplace" — that's
-- the loosest reading and matches how the wizard's gtin-status
-- endpoint treated those rows before the column existed.

BEGIN;

ALTER TABLE "GtinExemptionApplication"
  ADD COLUMN IF NOT EXISTS "productType" TEXT;

CREATE INDEX IF NOT EXISTS
  "GtinExemptionApplication_brand_market_type_idx"
  ON "GtinExemptionApplication" ("brandName", "marketplace", "productType");

COMMIT;
