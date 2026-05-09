-- W8.1: Add sortOrder + publicId to ProductImage.
-- sortOrder drives drag-to-reorder on the inline Images tab.
-- publicId stores the Cloudinary asset ID for delete propagation.

ALTER TABLE "ProductImage" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProductImage" ADD COLUMN IF NOT EXISTS "publicId"   TEXT;

CREATE INDEX IF NOT EXISTS "ProductImage_productId_sortOrder_idx"
  ON "ProductImage"("productId", "sortOrder");
