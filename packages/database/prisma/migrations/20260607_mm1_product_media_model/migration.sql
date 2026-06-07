-- MM.1 — Unified product media model: media-type discriminator + video fields
-- on ProductImage and ListingImage. Additive: NOT NULL with a default, so all
-- existing rows backfill to 'IMAGE' and the image pipeline is unaffected.

ALTER TABLE "ProductImage" ADD COLUMN "mediaType" TEXT NOT NULL DEFAULT 'IMAGE';
ALTER TABLE "ProductImage" ADD COLUMN "posterUrl" TEXT;
ALTER TABLE "ProductImage" ADD COLUMN "durationSec" DOUBLE PRECISION;
ALTER TABLE "ProductImage" ADD COLUMN "sourceAssetId" TEXT;
CREATE INDEX "ProductImage_productId_mediaType_sortOrder_idx" ON "ProductImage"("productId", "mediaType", "sortOrder");

ALTER TABLE "ListingImage" ADD COLUMN "mediaType" TEXT NOT NULL DEFAULT 'IMAGE';
ALTER TABLE "ListingImage" ADD COLUMN "posterUrl" TEXT;
ALTER TABLE "ListingImage" ADD COLUMN "durationSec" DOUBLE PRECISION;
ALTER TABLE "ListingImage" ADD COLUMN "sourceAssetId" TEXT;
CREATE INDEX "ListingImage_productId_scope_platform_mediaType_idx" ON "ListingImage"("productId", "scope", "platform", "mediaType");
