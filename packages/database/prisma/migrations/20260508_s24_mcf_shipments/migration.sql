-- S.24 — Amazon MCF (Multi-Channel Fulfillment) shipment tracking.
--
-- One MCFShipment row per Amazon FulfillmentOrder we create. Maps a
-- non-Amazon Order (eBay, Shopify, etc) to the SP-API fulfillment
-- request that Amazon ships from FBA inventory.
--
-- Status lifecycle (Amazon's terms):
--   NEW          — request just received by Amazon
--   RECEIVED     — Amazon has the inventory request, queued
--   PLANNING     — picking + packing scheduled
--   PROCESSING   — picked, packed, awaiting carrier
--   CANCELLED    — operator or system cancellation
--   COMPLETE     — shipment handed to carrier (counts as 'shipped')
--   COMPLETE_PARTIALLED — partial fulfillment closed
--   UNFULFILLABLE — Amazon couldn't fulfill (out of stock, etc)
--   INVALID      — malformed request
--
-- Inventory deduction: reserveOpenOrder fires when MCFShipment is
-- created; consumeOpenOrder when status reaches COMPLETE; release
-- when CANCELLED. Same reserve-then-consume pattern S.2 / S.2.5
-- use for FBM/Shopify, applied to AMAZON-EU-FBA stock.

CREATE TABLE IF NOT EXISTS "MCFShipment" (
  "id"                       TEXT NOT NULL,
  "orderId"                  TEXT NOT NULL,
  "amazonFulfillmentOrderId" TEXT NOT NULL,
  "sellerFulfillmentOrderId" TEXT,                              -- our idempotency key
  "status"                   TEXT NOT NULL DEFAULT 'NEW',
  "marketplaceId"            TEXT,                              -- e.g. APJ6JRA9NG5V4 (IT)
  "displayableOrderId"       TEXT,
  "shippingSpeedCategory"    TEXT,                              -- 'Standard'|'Expedited'|'Priority'
  "requestedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "shippedAt"                TIMESTAMP(3),
  "deliveredAt"              TIMESTAMP(3),
  "cancelledAt"              TIMESTAMP(3),
  "lastSyncedAt"             TIMESTAMP(3),
  "trackingNumber"           TEXT,
  "carrier"                  TEXT,
  "rawResponse"              JSONB,                              -- last SP-API response
  "lastError"                TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MCFShipment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MCFShipment_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MCFShipment_amazonFulfillmentOrderId_key"
  ON "MCFShipment"("amazonFulfillmentOrderId");
CREATE INDEX IF NOT EXISTS "MCFShipment_orderId_idx"
  ON "MCFShipment"("orderId");
CREATE INDEX IF NOT EXISTS "MCFShipment_status_idx"
  ON "MCFShipment"("status");
CREATE INDEX IF NOT EXISTS "MCFShipment_requestedAt_idx"
  ON "MCFShipment"("requestedAt");
