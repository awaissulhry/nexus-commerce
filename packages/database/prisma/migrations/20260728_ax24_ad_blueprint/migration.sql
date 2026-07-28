-- AX2.4 — Structure Blueprints (read side).
--
-- A named, product-agnostic description of a working campaign structure,
-- extracted from live campaigns with everything product-specific (ASINs, brand
-- keywords, name tokens) parameterised out. Read-side only: nothing here
-- creates anything on Amazon. Additive.

CREATE TABLE IF NOT EXISTS "AdBlueprint" (
  "id"                TEXT PRIMARY KEY,
  "name"              TEXT NOT NULL,
  "description"       TEXT,
  "marketplace"       TEXT NOT NULL,
  "adProduct"         TEXT NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
  "productToken"      TEXT NOT NULL,
  "competitorTokens"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sourceCampaignIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "doc"               JSONB NOT NULL,
  "createdBy"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdBlueprint_name_key" ON "AdBlueprint" ("name");
CREATE INDEX IF NOT EXISTS "AdBlueprint_marketplace_idx" ON "AdBlueprint" ("marketplace");
