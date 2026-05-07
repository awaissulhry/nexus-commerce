-- O.1 — Outbound rebuild foundation: extend OrderStatus enum + add
-- Order fulfillment-deadline fields (shipByDate, earliestShipDate,
-- latestDeliveryDate, fulfillmentLatency, isPrime).
--
-- Why:
--   • OrderStatus today is PENDING/SHIPPED/CANCELLED/DELIVERED. Channel
--     ingestion (woocommerce-sync.service.ts:538) already returns
--     'PROCESSING'/'COMPLETED'/'FAILED'/'REFUNDED' — those writes have
--     been silently failing. New enum values: PROCESSING,
--     PARTIALLY_SHIPPED, ON_HOLD, AWAITING_PAYMENT, REFUNDED, RETURNED.
--   • The cornerstone outbound surface (O.4) needs ship-by urgency,
--     Prime gating, and EDD math — none of those have a column today.
--
-- Pattern: ADD VALUE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS, mirroring
-- D.1 (20260505_d1_orders_extensions_reviews). Backfill shipByDate from
-- amazonMetadata where the raw SP-API payload preserves it; leave NULL
-- elsewhere — next channel-sync tick will repopulate from raw metadata.

-- ── Expand OrderStatus enum ───────────────────────────────────────────
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_SHIPPED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'AWAITING_PAYMENT';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETURNED';

-- ── Order fulfillment-deadline fields ─────────────────────────────────
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "shipByDate"          TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "earliestShipDate"    TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "latestDeliveryDate"  TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "fulfillmentLatency"  INTEGER;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "isPrime"             BOOLEAN;

-- ── Indexes for the urgency + late-risk hot paths ─────────────────────
-- Single-column on shipByDate (sort/filter) plus composite to support
-- "actionable orders by ship-by ASC". Status-filtered partial index
-- skipped — keeping Prisma reads simple; revisit at >100k rows.
CREATE INDEX IF NOT EXISTS "Order_shipByDate_idx"
    ON "Order"("shipByDate");
CREATE INDEX IF NOT EXISTS "Order_status_shipByDate_idx"
    ON "Order"("status", "shipByDate");
-- Partial index — Prime SFP routing is the only consumer; tiny set.
CREATE INDEX IF NOT EXISTS "Order_isPrime_idx"
    ON "Order"("isPrime") WHERE "isPrime" = true;

-- ── Backfill shipByDate from amazonMetadata where preserved ───────────
-- Amazon SP-API: LatestShipDate / EarliestShipDate / LatestDeliveryDate
-- live on the raw order payload, which we stored verbatim in
-- amazonMetadata. eBay/Shopify/Woo metadata don't carry these — leave
-- NULL; next channel-sync tick will populate.
--
-- Cast pattern: jsonb ->> 'key' returns TEXT; ::timestamp parses it.
-- ::boolean accepts 'true'/'false' strings.
UPDATE "Order"
SET "shipByDate"          = ("amazonMetadata"->>'LatestShipDate')::timestamp,
    "earliestShipDate"    = ("amazonMetadata"->>'EarliestShipDate')::timestamp,
    "latestDeliveryDate"  = ("amazonMetadata"->>'LatestDeliveryDate')::timestamp,
    "isPrime"             = ("amazonMetadata"->>'IsPrime')::boolean
WHERE "channel" = 'AMAZON'
  AND "amazonMetadata" IS NOT NULL
  AND "shipByDate" IS NULL
  AND "amazonMetadata" ? 'LatestShipDate';
