-- eBay flat-file push-history: durable record of every "Push to eBay" so a failed
-- push is inspectable forever (parallel to AmazonFlatFileFeedJob).

CREATE TABLE "EbayPushJob" (
    "id"            TEXT NOT NULL,
    "mode"          TEXT NOT NULL,
    "taskId"        TEXT,
    "markets"       JSONB,
    "skuCount"      INTEGER NOT NULL DEFAULT 0,
    "status"        TEXT NOT NULL DEFAULT 'SUBMITTED',
    "pushed"        INTEGER NOT NULL DEFAULT 0,
    "failed"        INTEGER NOT NULL DEFAULT 0,
    "perSkuResults" JSONB,
    "warnings"      JSONB,
    "errorMessage"  TEXT,
    "submittedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"   TIMESTAMP(3),
    CONSTRAINT "EbayPushJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EbayPushJob_status_submittedAt_idx" ON "EbayPushJob"("status", "submittedAt" DESC);
