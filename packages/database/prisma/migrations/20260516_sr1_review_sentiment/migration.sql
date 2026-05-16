-- SR.1 — Sentient Review Loop substrate.
-- Review (ingested text) + ReviewSentiment (AI classification) +
-- ReviewCategoryRate (rolling counters) + ReviewSpike (spike audit).

CREATE TABLE IF NOT EXISTS "Review" (
  "id" TEXT PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "marketplace" TEXT,
  "externalReviewId" TEXT NOT NULL,
  "productId" TEXT REFERENCES "Product"("id") ON DELETE SET NULL,
  "asin" TEXT,
  "sku" TEXT,
  "rating" INTEGER,
  "title" TEXT,
  "body" TEXT NOT NULL,
  "authorName" TEXT,
  "authorId" TEXT,
  "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false,
  "helpfulVotes" INTEGER NOT NULL DEFAULT 0,
  "postedAt" TIMESTAMP(3) NOT NULL,
  "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawPayload" JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS "Review_channel_externalReviewId_key"
  ON "Review" ("channel", "externalReviewId");
CREATE INDEX IF NOT EXISTS "Review_productId_postedAt_idx"
  ON "Review" ("productId", "postedAt");
CREATE INDEX IF NOT EXISTS "Review_marketplace_postedAt_idx"
  ON "Review" ("marketplace", "postedAt");
CREATE INDEX IF NOT EXISTS "Review_postedAt_idx" ON "Review" ("postedAt");

CREATE TABLE IF NOT EXISTS "ReviewSentiment" (
  "id" TEXT PRIMARY KEY,
  "reviewId" TEXT NOT NULL UNIQUE REFERENCES "Review"("id") ON DELETE CASCADE,
  "label" TEXT NOT NULL,
  "score" DECIMAL(4, 3) NOT NULL,
  "categories" TEXT[] NOT NULL DEFAULT '{}',
  "topPhrases" TEXT[] NOT NULL DEFAULT '{}',
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheHitTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "costUSD" DECIMAL(10, 6) NOT NULL DEFAULT 0,
  "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ReviewSentiment_label_idx" ON "ReviewSentiment" ("label");
CREATE INDEX IF NOT EXISTS "ReviewSentiment_extractedAt_idx" ON "ReviewSentiment" ("extractedAt");

CREATE TABLE IF NOT EXISTS "ReviewCategoryRate" (
  "id" TEXT PRIMARY KEY,
  "productId" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "total" INTEGER NOT NULL DEFAULT 0,
  "positive" INTEGER NOT NULL DEFAULT 0,
  "neutral" INTEGER NOT NULL DEFAULT 0,
  "negative" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReviewCategoryRate_productId_marketplace_category_date_key"
  ON "ReviewCategoryRate" ("productId", "marketplace", "category", "date");
CREATE INDEX IF NOT EXISTS "ReviewCategoryRate_productId_marketplace_category_date_idx"
  ON "ReviewCategoryRate" ("productId", "marketplace", "category", "date" DESC);

CREATE TABLE IF NOT EXISTS "ReviewSpike" (
  "id" TEXT PRIMARY KEY,
  "productId" TEXT REFERENCES "Product"("id") ON DELETE SET NULL,
  "marketplace" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "rate7dNumerator" INTEGER NOT NULL,
  "rate7dDenominator" INTEGER NOT NULL,
  "rate28dNumerator" INTEGER NOT NULL,
  "rate28dDenominator" INTEGER NOT NULL,
  "spikeMultiplier" DECIMAL(6, 2),
  "sampleTopPhrases" TEXT[] NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ReviewSpike_productId_marketplace_category_detectedAt_idx"
  ON "ReviewSpike" ("productId", "marketplace", "category", "detectedAt" DESC);
CREATE INDEX IF NOT EXISTS "ReviewSpike_status_detectedAt_idx"
  ON "ReviewSpike" ("status", "detectedAt" DESC);
