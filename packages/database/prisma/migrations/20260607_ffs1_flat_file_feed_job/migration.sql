-- FFS.1 — durable flat-file (JSON_LISTINGS_FEED) submission tracking
CREATE TABLE IF NOT EXISTS "AmazonFlatFileFeedJob" (
  "id"             TEXT NOT NULL,
  "feedId"         TEXT NOT NULL,
  "feedDocumentId" TEXT,
  "marketplace"    TEXT NOT NULL,
  "productType"    TEXT,
  "status"         TEXT NOT NULL DEFAULT 'IN_QUEUE',
  "skuCount"       INTEGER NOT NULL DEFAULT 0,
  "skus"           JSONB,
  "resultSummary"  JSONB,
  "perSkuResults"  JSONB,
  "errorMessage"   TEXT,
  "lastPolledAt"   TIMESTAMP(3),
  "pollCount"      INTEGER NOT NULL DEFAULT 0,
  "nextPollAt"     TIMESTAMP(3),
  "submittedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),
  CONSTRAINT "AmazonFlatFileFeedJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AmazonFlatFileFeedJob_feedId_key"
  ON "AmazonFlatFileFeedJob"("feedId");
CREATE INDEX IF NOT EXISTS "AmazonFlatFileFeedJob_marketplace_productType_idx"
  ON "AmazonFlatFileFeedJob"("marketplace","productType");
CREATE INDEX IF NOT EXISTS "AmazonFlatFileFeedJob_status_submittedAt_idx"
  ON "AmazonFlatFileFeedJob"("status","submittedAt");
CREATE INDEX IF NOT EXISTS "AmazonFlatFileFeedJob_nextPollAt_idx"
  ON "AmazonFlatFileFeedJob"("nextPollAt");
