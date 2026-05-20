-- IR.2.1 — Asset metadata columns on ProductImage.
--
-- Mirrors the same four columns already present on ListingImage so
-- QualityChecklist + Amazon matrix per-cell warnings + master gallery
-- dimension display can read uniformly across both tables.
--
-- All nullable, no backfill in this migration. Existing rows stay at
-- NULL until scripts/backfill-product-image-metadata.mjs runs (separate
-- manual operation; see IR.2.4). Upload route from IR.2.2 onward
-- populates these on every new ProductImage.

ALTER TABLE "ProductImage" ADD COLUMN "width"    INTEGER;
ALTER TABLE "ProductImage" ADD COLUMN "height"   INTEGER;
ALTER TABLE "ProductImage" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "ProductImage" ADD COLUMN "fileSize" INTEGER;
