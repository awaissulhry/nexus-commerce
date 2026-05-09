-- CS.1 — Channel-to-us stock reconciliation infrastructure.
--
-- Closes TECH_DEBT #43. We push outbound stock to channels via
-- OutboundSyncQueue but channel-side adjustments (Shopify admin
-- edits, eBay merchant corrections, FBA inbound losses) drift our
-- local StockLevel without an inbound path.
--
-- This migration ships the foundation: enum value + table.
-- Webhook ingester is CS.2; operator UI is CS.3.

-- ── Enum: new movement reason ─────────────────────────────────────
ALTER TYPE "StockMovementReason"
  ADD VALUE IF NOT EXISTS 'CHANNEL_STOCK_RECONCILIATION';

-- ── Enum: ChannelStockEventStatus ─────────────────────────────────
CREATE TYPE "ChannelStockEventStatus" AS ENUM (
  'PENDING',
  'AUTO_APPLIED',
  'REVIEW_NEEDED',
  'APPLIED',
  'IGNORED'
);

-- ── Table ──────────────────────────────────────────────────────────
CREATE TABLE "ChannelStockEvent" (
  "id"                    TEXT NOT NULL,
  "channel"               TEXT NOT NULL,
  "channelEventId"        TEXT NOT NULL,
  "productId"             TEXT,
  "variationId"           TEXT,
  "sku"                   TEXT NOT NULL,
  "locationId"            TEXT,
  "channelReportedQty"    INTEGER NOT NULL,
  "localQtyAtObservation" INTEGER NOT NULL,
  "drift"                 INTEGER NOT NULL,
  "status"                "ChannelStockEventStatus" NOT NULL DEFAULT 'PENDING',
  "resolution"            TEXT,
  "resultingMovementId"   TEXT,
  "resolvedByUserId"      TEXT,
  "resolvedAt"            TIMESTAMP(3),
  "rawPayload"            JSONB,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannelStockEvent_pkey" PRIMARY KEY ("id")
);

-- Idempotency: webhook retries land the same channelEventId; accept
-- the event at most once per (channel, channelEventId).
CREATE UNIQUE INDEX "ChannelStockEvent_channel_channelEventId_key"
  ON "ChannelStockEvent"("channel", "channelEventId");

CREATE INDEX "ChannelStockEvent_status_idx" ON "ChannelStockEvent"("status");
CREATE INDEX "ChannelStockEvent_channel_idx" ON "ChannelStockEvent"("channel");
CREATE INDEX "ChannelStockEvent_productId_idx" ON "ChannelStockEvent"("productId");
CREATE INDEX "ChannelStockEvent_sku_idx" ON "ChannelStockEvent"("sku");
CREATE INDEX "ChannelStockEvent_createdAt_idx" ON "ChannelStockEvent"("createdAt");

-- Operator triage hot path: list pending + review-needed across all
-- channels, newest first within channel.
CREATE INDEX "ChannelStockEvent_status_channel_createdAt_idx"
  ON "ChannelStockEvent"("status", "channel", "createdAt" DESC);

-- ── FK: productId → Product.id (SetNull on product delete so the
--    audit row survives a product hard-delete cleanup pass) ────────
ALTER TABLE "ChannelStockEvent"
  ADD CONSTRAINT "ChannelStockEvent_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Sanity CHECK: channelReportedQty cannot be negative.
--    Channels never legitimately report negative stock; if they do
--    it's a parsing bug and we want to fail loud, not silently
--    ingest garbage. ────────────────────────────────────────────────
ALTER TABLE "ChannelStockEvent"
  ADD CONSTRAINT "ChannelStockEvent_channelReportedQty_nonNegative"
  CHECK ("channelReportedQty" >= 0);

-- ── Sanity CHECK: drift = channelReportedQty - localQtyAtObservation.
--    Service code computes this at ingest; the constraint guards
--    against future hand-edits introducing inconsistency. ──────────
ALTER TABLE "ChannelStockEvent"
  ADD CONSTRAINT "ChannelStockEvent_drift_consistency"
  CHECK ("drift" = "channelReportedQty" - "localQtyAtObservation");
