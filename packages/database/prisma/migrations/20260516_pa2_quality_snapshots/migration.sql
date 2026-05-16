-- PA.2: Listing Quality Snapshot
-- Persists quality scores from scoreListingQuality() for trend tracking.
-- One row per product × channel × scoring event.

CREATE TABLE "ListingQualitySnapshot" (
  "id"          TEXT NOT NULL,
  "productId"   TEXT NOT NULL,
  "channel"     TEXT NOT NULL,
  "marketplace" TEXT,
  "overallScore" INTEGER NOT NULL,
  "dimensions"  JSONB NOT NULL,
  "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ListingQualitySnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ListingQualitySnapshot_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE
);

CREATE INDEX "ListingQualitySnapshot_productId_channel_createdAt_idx"
  ON "ListingQualitySnapshot"("productId", "channel", "createdAt" DESC);

CREATE INDEX "ListingQualitySnapshot_createdAt_idx"
  ON "ListingQualitySnapshot"("createdAt" DESC);
