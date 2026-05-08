-- S.25 — Pan-EU FBA distribution detail.
--
-- Read-only snapshot of Amazon FBA inventory broken down by
-- (sku × marketplace × fulfillment center × condition). The 15-min
-- summary cron (amazon-inventory.service) keeps the AGGREGATE
-- AMAZON-EU-FBA StockLevel fresh; this table adds the per-FC
-- dimensionality the operator needs for:
--   - Pan-EU distribution visibility (where does my stock physically sit?)
--   - Aged inventory tracking (long-term storage fee risk)
--   - Unfulfillable count (damaged/disposed candidates)
--
-- Cron: daily 03:00 UTC, fba-pan-eu-sync.job. NOT a StockLocation
-- per FC — Amazon owns Pan-EU redistribution and the operator
-- can't move stock between FCs, so ledger-side modelling adds
-- noise without value.
--
-- Conditions tracked: SELLABLE, UNFULFILLABLE, INBOUND (collapses
-- Amazon's Inbound-Working / Inbound-Shipped / Inbound-Receiving),
-- RESERVED, RESEARCHING.

CREATE TABLE IF NOT EXISTS "FbaInventoryDetail" (
  "id"                  TEXT NOT NULL,
  "productId"           TEXT,
  "sku"                 TEXT NOT NULL,
  "asin"                TEXT,
  "marketplaceId"       TEXT NOT NULL,
  "fulfillmentCenterId" TEXT NOT NULL,
  "condition"           TEXT NOT NULL,
  "quantity"            INTEGER NOT NULL DEFAULT 0,
  -- Earliest receipt at this FC × condition. NEW rows set this on
  -- creation; updates preserve it so age tracking is honest.
  "firstReceivedAt"     TIMESTAMP(3),
  "lastSyncedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawData"             JSONB,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FbaInventoryDetail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FbaInventoryDetail_productId_fkey" FOREIGN KEY ("productId")
    REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "FbaInventoryDetail_sku_market_fc_condition_unique_idx"
  ON "FbaInventoryDetail"("sku", "marketplaceId", "fulfillmentCenterId", "condition");

CREATE INDEX IF NOT EXISTS "FbaInventoryDetail_productId_idx"
  ON "FbaInventoryDetail"("productId");
CREATE INDEX IF NOT EXISTS "FbaInventoryDetail_marketplaceId_idx"
  ON "FbaInventoryDetail"("marketplaceId");
CREATE INDEX IF NOT EXISTS "FbaInventoryDetail_fulfillmentCenterId_idx"
  ON "FbaInventoryDetail"("fulfillmentCenterId");
CREATE INDEX IF NOT EXISTS "FbaInventoryDetail_condition_idx"
  ON "FbaInventoryDetail"("condition");
-- Aged-inventory hot path: oldest stock per condition.
CREATE INDEX IF NOT EXISTS "FbaInventoryDetail_firstReceivedAt_idx"
  ON "FbaInventoryDetail"("firstReceivedAt");
