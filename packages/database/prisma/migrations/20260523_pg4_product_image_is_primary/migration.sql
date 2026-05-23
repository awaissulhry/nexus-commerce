-- PG.4 — Operator-curated "hero image" flag for ProductImage.
--
-- Catalog thumbnail picker (pickFaceImage) becomes:
--   1. isPrimary=true  (this row — operator picked it)
--   2. type='MAIN'     (lowest sortOrder of these)
--   3. lowest sortOrder regardless of type
--   4. lowest createdAt
--
-- Single-selection per product is enforced two ways:
--   - Application: PATCH /api/products/:id/images/:imageId/primary
--     wraps the set+clear in a transaction.
--   - Database: partial UNIQUE index below — at most one row per
--     productId may have isPrimary=true, even if two operator
--     sessions race the API.
--
-- A regular @@index on (productId, isPrimary) supports the FE's
-- "what's the current primary?" lookup without scanning the gallery.

ALTER TABLE "ProductImage"
  ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- Partial unique index: only enforced on rows where isPrimary=true.
-- All other rows (the vast majority) are unconstrained and don't
-- bloat the B-tree.
CREATE UNIQUE INDEX "ProductImage_productId_isPrimary_unique_true"
  ON "ProductImage"("productId")
  WHERE "isPrimary" = true;

-- Mirror of @@index([productId, isPrimary]) from schema.prisma. The
-- FE drawer uses this for the "find this product's hero" lookup;
-- Prisma's @@index doesn't generate a partial, so we get both the
-- general index (here) and the partial unique (above).
CREATE INDEX "ProductImage_productId_isPrimary_idx"
  ON "ProductImage"("productId", "isPrimary");
