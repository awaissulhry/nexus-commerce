-- C.6 — Create the ChannelPublishAttempt audit table.
--
-- Every Amazon (and later eBay/Shopify/Woo/Etsy) publish ATTEMPT writes
-- one row here, regardless of outcome. Captures gated, dry-run,
-- sandbox, live, rate-limited, circuit-open, failed, and successful
-- attempts so the dryRun → sandbox → canary → graduated rollout has
-- a forensic trail.
--
-- Distinct from SyncAttempt (S.4) which logs RESYNC pulls — different
-- shape (no submissionId; payloadDigest doesn't apply to reads).
--
-- Pure additive migration. Indexes target the rollout dashboards we'll
-- add in a later commit (per-channel timeline, per-SKU timeline,
-- "what's failing right now").

-- CreateTable
CREATE TABLE "ChannelPublishAttempt" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productId" TEXT,
    "mode" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "submissionId" TEXT,
    "payloadDigest" TEXT NOT NULL,
    "durationMs" INTEGER,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelPublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_channel_marketplace_attemptedAt_idx"
    ON "ChannelPublishAttempt"("channel", "marketplace", "attemptedAt");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_sku_attemptedAt_idx"
    ON "ChannelPublishAttempt"("sku", "attemptedAt");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_outcome_attemptedAt_idx"
    ON "ChannelPublishAttempt"("outcome", "attemptedAt");

-- CreateIndex
CREATE INDEX "ChannelPublishAttempt_productId_idx"
    ON "ChannelPublishAttempt"("productId");

-- AddForeignKey — SetNull so cleaning up an orphan Product doesn't
-- erase the audit trail. The publish history is forensic value even
-- after the master row is gone.
ALTER TABLE "ChannelPublishAttempt" ADD CONSTRAINT "ChannelPublishAttempt_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
