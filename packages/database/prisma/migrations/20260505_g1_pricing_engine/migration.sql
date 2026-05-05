-- G.1 — Pricing engine schema additions.
--
-- Three new tables (PricingSnapshot, FxRate, RetailEventPriceAction) plus
-- column additions on Marketplace + ChannelListing. Together they back the
-- pricing engine + materialization + matrix UI work in G.1–G.5.

-- ─── Marketplace: tax + FBA program metadata ─────────────────────────
ALTER TABLE "Marketplace"
  ADD COLUMN "vatRate"      DECIMAL(5, 2),
  ADD COLUMN "taxInclusive" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "fbaProgram"   TEXT;

-- ─── ChannelListing: SP-API fee + competitive snapshots ──────────────
ALTER TABLE "ChannelListing"
  ADD COLUMN "estimatedFbaFee"       DECIMAL(10, 2),
  ADD COLUMN "referralFeePercent"    DECIMAL(5, 2),
  ADD COLUMN "lowestCompetitorPrice" DECIMAL(10, 2),
  ADD COLUMN "competitorFetchedAt"   TIMESTAMP(3),
  ADD COLUMN "feeFetchedAt"          TIMESTAMP(3),
  ADD COLUMN "bestOfferFloor"        DECIMAL(10, 2);

-- ─── PricingSnapshot ─────────────────────────────────────────────────
CREATE TABLE "PricingSnapshot" (
  "id"                TEXT PRIMARY KEY,
  "sku"               TEXT NOT NULL,
  "channel"           TEXT NOT NULL,
  "marketplace"       TEXT NOT NULL,
  "fulfillmentMethod" TEXT,

  "computedPrice"     DECIMAL(12, 2) NOT NULL,
  "currency"          TEXT NOT NULL,

  "source"            TEXT NOT NULL,
  "breakdown"         JSONB NOT NULL DEFAULT '{}',

  "isClamped"         BOOLEAN NOT NULL DEFAULT FALSE,
  "clampedFrom"       DECIMAL(12, 2),
  "warnings"          TEXT[] NOT NULL DEFAULT '{}',

  "computedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The unique covers fulfillmentMethod with a NULL — Postgres treats
-- NULL as distinct in indexes, so we need a partial unique to enforce
-- the canonical "default fulfillment" row uniqueness too.
CREATE UNIQUE INDEX "PricingSnapshot_sku_channel_marketplace_fm_key"
  ON "PricingSnapshot" ("sku", "channel", "marketplace", "fulfillmentMethod");

CREATE UNIQUE INDEX "PricingSnapshot_sku_channel_marketplace_default_key"
  ON "PricingSnapshot" ("sku", "channel", "marketplace")
  WHERE "fulfillmentMethod" IS NULL;

CREATE INDEX "PricingSnapshot_sku_idx" ON "PricingSnapshot" ("sku");
CREATE INDEX "PricingSnapshot_channel_marketplace_idx"
  ON "PricingSnapshot" ("channel", "marketplace");
CREATE INDEX "PricingSnapshot_source_idx" ON "PricingSnapshot" ("source");
CREATE INDEX "PricingSnapshot_computedAt_idx" ON "PricingSnapshot" ("computedAt");

-- ─── FxRate ──────────────────────────────────────────────────────────
CREATE TABLE "FxRate" (
  "id"           TEXT PRIMARY KEY,
  "fromCurrency" TEXT NOT NULL,
  "toCurrency"   TEXT NOT NULL,
  "rate"         DECIMAL(14, 8) NOT NULL,
  "asOf"         DATE NOT NULL,
  "source"       TEXT NOT NULL DEFAULT 'frankfurter',

  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "FxRate_fromCurrency_toCurrency_asOf_key"
  ON "FxRate" ("fromCurrency", "toCurrency", "asOf");
CREATE INDEX "FxRate_asOf_idx" ON "FxRate" ("asOf");

-- ─── RetailEventPriceAction ──────────────────────────────────────────
CREATE TABLE "RetailEventPriceAction" (
  "id"                TEXT PRIMARY KEY,
  "eventId"           TEXT NOT NULL,

  "channel"           TEXT,
  "marketplace"       TEXT,
  "productType"       TEXT,

  "action"            TEXT NOT NULL, -- 'PERCENT_OFF' | 'FIXED_PRICE'
  "value"             DECIMAL(10, 2) NOT NULL,

  "isActive"          BOOLEAN NOT NULL DEFAULT TRUE,

  "setSalePriceFrom"  TIMESTAMP(3),
  "setSalePriceUntil" TIMESTAMP(3),

  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RetailEventPriceAction_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "RetailEvent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RetailEventPriceAction_eventId_idx"
  ON "RetailEventPriceAction" ("eventId");
CREATE INDEX "RetailEventPriceAction_isActive_idx"
  ON "RetailEventPriceAction" ("isActive");
