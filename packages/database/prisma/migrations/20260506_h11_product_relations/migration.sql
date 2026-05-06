-- =====================================================================
-- H.11: Related products / cross-sells
--
-- Links one product to another with a typed relationship. Listing
-- surfaces (eBay related items, Amazon recommended bundles, future
-- "buy together" badges) read this table so cross-sells live in one
-- place rather than being hand-curated per channel.
--
-- See packages/database/prisma/schema.prisma → ProductRelation for the
-- semantics of each `type` value (CROSS_SELL, ACCESSORY, REPLACEMENT,
-- BUNDLE_PART, UPSELL, RECOMMENDED).
--
-- Indexes:
--   - (fromProductId, toProductId, type) UNIQUE — one relation per
--     (pair, type) tuple. Different types between the same pair are
--     allowed (e.g. "Pro upsells Standard" + "Standard cross-sells
--     Pro" if you really want both).
--   - (fromProductId, type) — drawer's per-product outgoing list,
--     filtered by type.
--   - (toProductId, type) — "what links *to* this product?" lookup.
-- =====================================================================

CREATE TABLE "ProductRelation" (
  "id"            TEXT PRIMARY KEY,
  "fromProductId" TEXT NOT NULL,
  "toProductId"   TEXT NOT NULL,
  "type"          TEXT NOT NULL,
  "displayOrder"  INTEGER NOT NULL DEFAULT 0,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductRelation_fromProductId_fkey"
    FOREIGN KEY ("fromProductId") REFERENCES "Product" ("id") ON DELETE CASCADE,
  CONSTRAINT "ProductRelation_toProductId_fkey"
    FOREIGN KEY ("toProductId") REFERENCES "Product" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "ProductRelation_from_to_type_key"
  ON "ProductRelation" ("fromProductId", "toProductId", "type");
CREATE INDEX "ProductRelation_fromProductId_type_idx"
  ON "ProductRelation" ("fromProductId", "type");
CREATE INDEX "ProductRelation_toProductId_type_idx"
  ON "ProductRelation" ("toProductId", "type");
