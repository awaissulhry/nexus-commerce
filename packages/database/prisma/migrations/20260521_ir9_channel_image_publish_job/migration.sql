-- IR.9.1 — ChannelImagePublishJob log for eBay + Shopify.
--
-- Parallel to AmazonImageFeedJob. Lets the publish-history dashboard
-- show the full lifecycle for every channel and gives the retry
-- button a row to look up.

CREATE TABLE "ChannelImagePublishJob" (
  "id"             TEXT NOT NULL,
  "productId"      TEXT NOT NULL,
  "channel"        TEXT NOT NULL,
  "marketplace"    TEXT,
  "status"         TEXT NOT NULL DEFAULT 'SUBMITTING',
  "errorMessage"   TEXT,
  "requestPayload" JSONB,
  "response"       JSONB,
  "vendorEntityId" TEXT,
  "submittedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),

  CONSTRAINT "ChannelImagePublishJob_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChannelImagePublishJob"
  ADD CONSTRAINT "ChannelImagePublishJob_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ChannelImagePublishJob_productId_channel_idx"
  ON "ChannelImagePublishJob"("productId", "channel");
CREATE INDEX "ChannelImagePublishJob_status_submittedAt_idx"
  ON "ChannelImagePublishJob"("status", "submittedAt");
CREATE INDEX "ChannelImagePublishJob_channel_status_idx"
  ON "ChannelImagePublishJob"("channel", "status");
