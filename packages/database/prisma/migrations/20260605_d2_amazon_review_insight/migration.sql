-- D.2 — Amazon official Customer Feedback API (v2024-06-01) insights.
--
-- Aggregate per ASIN × marketplace: Amazon exposes NO review TEXT via API for
-- sellers, only top positive/negative topics (with mention counts, star-rating
-- impact, and customer snippets) + a month-over-month star trend, refreshed
-- weekly. This table holds that signal, distinct from Review (individual rows
-- from eBay feedback / manual import). Fully additive — nothing references it
-- yet, so this is safe to apply on a live DB.

CREATE TABLE "AmazonReviewInsight" (
    "id" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productId" TEXT,
    "starRating" DOUBLE PRECISION,
    "reviewCount" INTEGER,
    "positiveTopics" JSONB NOT NULL DEFAULT '[]',
    "negativeTopics" JSONB NOT NULL DEFAULT '[]',
    "snippets" JSONB NOT NULL DEFAULT '[]',
    "trend" JSONB NOT NULL DEFAULT '[]',
    "accessStatus" TEXT NOT NULL DEFAULT 'OK',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB,

    CONSTRAINT "AmazonReviewInsight_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AmazonReviewInsight_asin_marketplace_key" ON "AmazonReviewInsight"("asin", "marketplace");
CREATE INDEX "AmazonReviewInsight_productId_idx" ON "AmazonReviewInsight"("productId");
CREATE INDEX "AmazonReviewInsight_marketplace_fetchedAt_idx" ON "AmazonReviewInsight"("marketplace", "fetchedAt");
CREATE INDEX "AmazonReviewInsight_accessStatus_idx" ON "AmazonReviewInsight"("accessStatus");

ALTER TABLE "AmazonReviewInsight" ADD CONSTRAINT "AmazonReviewInsight_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
