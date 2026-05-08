-- O.5 — OrderItem.externalLineItemId + (orderId, externalLineItemId)
-- compound unique. Foundation for stable per-line idempotency across
-- channel-webhook redelivery.
--
-- Why:
--   • Pre-O.5, every channel ingestion path (amazon-orders.service,
--     shopify-webhooks, ebay-orders.service) used delete-then-create
--     to refresh OrderItem rows. End-state idempotency was fine, but
--     OrderItem.id churned on every webhook redelivery — and the
--     in-flight ReturnItem.orderItemId mapping (currently null per
--     a "follow-up" comment in shopify-webhooks.ts:533) would have
--     orphaned every time Shopify retried a refund webhook.
--   • Same SKU CAN appear on multiple lines of the same order at
--     different prices (per the explicit comment in
--     amazon-orders.service.ts:351-358), so a (orderId, sku) unique
--     would corrupt legitimate orders. (orderId, externalLineItemId)
--     is the right key — it's the channel-side immutable line id.
--
-- Pattern: ADD COLUMN nullable + JSON-metadata backfill + standard
-- compound unique. Postgres treats NULL as distinct in unique indexes,
-- so legacy rows + future channels that don't carry a per-line id
-- (Woo today) keep working without a partial-index dance.
--
-- Backfill sources:
--   AMAZON: amazonMetadata->>'OrderItemId' (Amazon's per-line id)
--   EBAY:   ebayMetadata->>'lineItemId'    (eBay's per-line id)
--   SHOPIFY/WOO: not in the JSON we currently store on OrderItem;
--                left NULL — next webhook tick repopulates via the
--                upsert paths in this commit's code changes.

-- ── Add column ────────────────────────────────────────────────────────
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "externalLineItemId" TEXT;

-- ── Backfill from JSON metadata (Amazon) ──────────────────────────────
UPDATE "OrderItem"
   SET "externalLineItemId" = "amazonMetadata"->>'OrderItemId'
 WHERE "externalLineItemId" IS NULL
   AND "amazonMetadata" IS NOT NULL
   AND "amazonMetadata" ? 'OrderItemId';

-- ── Backfill from JSON metadata (eBay) ────────────────────────────────
UPDATE "OrderItem"
   SET "externalLineItemId" = "ebayMetadata"->>'lineItemId'
 WHERE "externalLineItemId" IS NULL
   AND "ebayMetadata" IS NOT NULL
   AND "ebayMetadata" ? 'lineItemId';

-- ── Indexes ───────────────────────────────────────────────────────────
-- Compound unique. NULLs distinct under standard Postgres semantics
-- means legacy/no-id rows coexist; only set values are deduped.
CREATE UNIQUE INDEX IF NOT EXISTS "OrderItem_orderId_externalLineItemId_key"
  ON "OrderItem" ("orderId", "externalLineItemId");

-- Lookup: occasionally we need to resolve a Return refund line back to
-- the OrderItem by the channel's own line id (e.g. Shopify refunds/
-- create webhook references refund_line_items[].line_item.id). A
-- non-unique index on the column alone supports those probes without
-- forcing a join through Order.
CREATE INDEX IF NOT EXISTS "OrderItem_externalLineItemId_idx"
  ON "OrderItem" ("externalLineItemId");
