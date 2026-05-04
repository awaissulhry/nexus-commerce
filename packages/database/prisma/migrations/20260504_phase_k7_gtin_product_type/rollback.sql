-- Reverse of 20260504_phase_k7_gtin_product_type.

BEGIN;

DROP INDEX IF EXISTS "GtinExemptionApplication_brand_market_type_idx";

ALTER TABLE "GtinExemptionApplication"
  DROP COLUMN IF EXISTS "productType";

COMMIT;
