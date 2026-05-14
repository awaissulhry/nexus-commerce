-- IM.1: Image Workspace schema extension
-- Extends ListingImage with Amazon slot codes, variant grouping, and
-- publish tracking. Adds AmazonImageFeedJob for feed submission audit.
-- Adds imageAxisPreference to Product for persisting the matrix axis choice.

-- Product: image axis preference (e.g. "Color")
ALTER TABLE "Product" ADD COLUMN "imageAxisPreference" TEXT;

-- ListingImage: Amazon slot code
ALTER TABLE "ListingImage" ADD COLUMN "amazonSlot" TEXT;

-- ListingImage: variant axis grouping
ALTER TABLE "ListingImage" ADD COLUMN "variantGroupKey" TEXT;
ALTER TABLE "ListingImage" ADD COLUMN "variantGroupValue" TEXT;

-- ListingImage: channel publish tracking
ALTER TABLE "ListingImage" ADD COLUMN "publishStatus" TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "ListingImage" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "ListingImage" ADD COLUMN "publishError" TEXT;

-- ListingImage: new indexes for Amazon slot and variant group lookups
CREATE INDEX "ListingImage_productId_platform_amazonSlot_idx"
  ON "ListingImage"("productId", "platform", "amazonSlot");

CREATE INDEX "ListingImage_productId_variantGroupKey_variantGroupValue_idx"
  ON "ListingImage"("productId", "variantGroupKey", "variantGroupValue");

-- AmazonImageFeedJob: tracks JSON_LISTINGS_FEED image submissions
CREATE TABLE "AmazonImageFeedJob" (
  "id"             TEXT NOT NULL,
  "productId"      TEXT NOT NULL,
  "marketplace"    TEXT NOT NULL,
  "feedId"         TEXT,
  "feedDocumentId" TEXT,
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "skus"           JSONB NOT NULL,
  "errorMessage"   TEXT,
  "resultSummary"  JSONB,
  "submittedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),

  CONSTRAINT "AmazonImageFeedJob_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmazonImageFeedJob"
  ADD CONSTRAINT "AmazonImageFeedJob_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AmazonImageFeedJob_productId_marketplace_idx"
  ON "AmazonImageFeedJob"("productId", "marketplace");

CREATE INDEX "AmazonImageFeedJob_feedId_idx"
  ON "AmazonImageFeedJob"("feedId");

CREATE INDEX "AmazonImageFeedJob_status_submittedAt_idx"
  ON "AmazonImageFeedJob"("status", "submittedAt");
