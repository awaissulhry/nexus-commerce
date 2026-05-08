-- Pricing F.1 — BuyBoxHistory.
--
-- Per-marketplace, per-product timeseries of Buy Box state observed by the
-- daily SP-API competitive-pricing refresh (sp-api-pricing.service.ts:215).
-- Each row captures one getItemOffersBatch observation: the Buy Box price,
-- the lowest competitor price, whether our seller account held the box,
-- the winning seller ID (when SP-API exposes it), and the fulfillment
-- method on the winning offer.
--
-- This unlocks:
--   - Win-rate trend per SKU / per marketplace (count(*) FILTER (WHERE
--     isOurOffer=true) / count(*) over a rolling window)
--   - "Who's beating us today vs last week" (group by winnerSellerId)
--   - Repricer feedback ("we cut €0.50, did we win the box?")
--
-- Single-row Product.buyBoxPrice stays as the most-recent snapshot — the
-- existing matrix UI continues to read it. The history table is additive.

CREATE TABLE IF NOT EXISTS "BuyBoxHistory" (
  "id"                    TEXT NOT NULL,
  "productId"             TEXT NOT NULL,
  "channel"               TEXT NOT NULL,
  "marketplace"           TEXT NOT NULL,
  "observedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "buyBoxPrice"           DECIMAL(10, 2),
  "lowestCompetitorPrice" DECIMAL(10, 2),
  "isOurOffer"            BOOLEAN NOT NULL DEFAULT false,
  "winnerSellerId"        TEXT,
  "fulfillmentMethod"     TEXT,
  CONSTRAINT "BuyBoxHistory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BuyBoxHistory"
  ADD CONSTRAINT "BuyBoxHistory_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "BuyBoxHistory_productId_observedAt_idx"
  ON "BuyBoxHistory"("productId", "observedAt");

CREATE INDEX IF NOT EXISTS "BuyBoxHistory_channel_marketplace_observedAt_idx"
  ON "BuyBoxHistory"("channel", "marketplace", "observedAt");

CREATE INDEX IF NOT EXISTS "BuyBoxHistory_isOurOffer_observedAt_idx"
  ON "BuyBoxHistory"("isOurOffer", "observedAt");
