-- W4.1 — CustomerGroup + ProductTierPrice.
--
-- Magento-parity volume-discount + customer-group pricing. Two
-- tables:
--
--   CustomerGroup     — top-level segmentation ('guest',
--                       'retail_b2b', 'wholesale_b2b'). Minimal:
--                       code + label + description. Downstream
--                       discount rules, payment terms, credit
--                       limits build on this join key.
--   ProductTierPrice  — per-product per-(minQty, optional group)
--                       discount price. Resolver (W4.2) picks the
--                       highest-minQty row whose threshold is met,
--                       preferring group-specific over generic.
--                       Falls back to Product.basePrice when no
--                       tier matches.
--
-- Cascade rules:
--   Product → ProductTierPrice         : CASCADE (owned by product)
--   CustomerGroup → ProductTierPrice   : CASCADE (group-specific
--                                        rows go with the group;
--                                        generic rows with null
--                                        customerGroupId survive)
--
-- Idempotent (IF NOT EXISTS + pg_constraint guards).

-- ── CustomerGroup ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CustomerGroup" (
  "id"          TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "description" TEXT,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP NOT NULL,

  CONSTRAINT "CustomerGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerGroup_code_key"
  ON "CustomerGroup"("code");

-- ── ProductTierPrice ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProductTierPrice" (
  "id"              TEXT NOT NULL,
  "productId"       TEXT NOT NULL,
  "minQty"          INTEGER NOT NULL,
  "price"           DECIMAL(10, 2) NOT NULL,
  "customerGroupId" TEXT,
  "createdAt"       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP NOT NULL,

  CONSTRAINT "ProductTierPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductTierPrice_productId_minQty_customerGroupId_key"
  ON "ProductTierPrice"("productId", "minQty", "customerGroupId");

CREATE INDEX IF NOT EXISTS "ProductTierPrice_productId_idx"
  ON "ProductTierPrice"("productId");

CREATE INDEX IF NOT EXISTS "ProductTierPrice_customerGroupId_idx"
  ON "ProductTierPrice"("customerGroupId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProductTierPrice_productId_fkey'
  ) THEN
    ALTER TABLE "ProductTierPrice"
      ADD CONSTRAINT "ProductTierPrice_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProductTierPrice_customerGroupId_fkey'
  ) THEN
    ALTER TABLE "ProductTierPrice"
      ADD CONSTRAINT "ProductTierPrice_customerGroupId_fkey"
      FOREIGN KEY ("customerGroupId") REFERENCES "CustomerGroup"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
