-- PB.10 — Scheduled image publish.
--
-- A row holds the future-dated intent to publish a product's images
-- to a specific channel (+ optional marketplace for Amazon). A cron
-- worker (apps/api/src/jobs/scheduled-image-publish.job.ts) polls for
-- PENDING rows where scheduledFor <= now, dispatches the publish via
-- the same handlers /amazon-images/publish + /ebay-images/publish +
-- /shopify-images/publish use, and writes the outcome back.
--
-- Why a dedicated table (vs. piggybacking on ChannelImagePublishJob):
-- ChannelImagePublishJob represents WORK IN FLIGHT (submitted to the
-- channel, awaiting result). Scheduled rows are work NOT YET FIRED —
-- different lifecycle. Operator cancellation only makes sense on the
-- scheduled row.

CREATE TABLE IF NOT EXISTS "ScheduledImagePublish" (
  "id"           TEXT NOT NULL,
  "productId"    TEXT NOT NULL,
  -- 'AMAZON' | 'EBAY' | 'SHOPIFY'
  "channel"      TEXT NOT NULL,
  -- For Amazon: 'IT' | 'DE' | 'FR' | 'ES' | 'UK' | 'ALL'
  -- For eBay + Shopify: NULL (single-store at this layer)
  "marketplace"  TEXT,

  "scheduledFor" TIMESTAMP(3) NOT NULL,

  -- PENDING | FIRED | FAILED | CANCELLED
  "status"       TEXT NOT NULL DEFAULT 'PENDING',

  "firedAt"      TIMESTAMP(3),
  "cancelledAt"  TIMESTAMP(3),

  "fireResult"   JSONB,
  "fireError"    TEXT,

  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "createdBy"    TEXT,

  CONSTRAINT "ScheduledImagePublish_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledImagePublish_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Cron worker scans PENDING in time order.
CREATE INDEX IF NOT EXISTS "ScheduledImagePublish_status_scheduledFor_idx"
  ON "ScheduledImagePublish"("status", "scheduledFor");

-- Operator viewing one product's pending schedules.
CREATE INDEX IF NOT EXISTS "ScheduledImagePublish_productId_idx"
  ON "ScheduledImagePublish"("productId");
