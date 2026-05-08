-- S.20 — Costing methodology (FIFO / LIFO / Weighted Average Cost)
-- with landed-cost breakdown and per-shipment COGS audit.
--
-- Schema additions:
--   StockCostLayer  (new) — one row per receive event; FIFO/LIFO
--                            consume in receivedAt order, WAC reads
--                            Product.weightedAvgCostCents directly.
--   Product.costingMethod         — 'FIFO' | 'LIFO' | 'WAC' (default WAC).
--   Product.weightedAvgCostCents  — rolling avg cost in cents; recomputed
--                                   on each receive when method=WAC.
--   StockMovement.cogsCents       — captured at consume time so reports
--                                   don't have to recompute historical COGS.
--
-- Backfill strategy: for every buyable Product with totalStock > 0,
-- create one synthetic seed layer with unitsRemaining = totalStock at
-- Product.costPrice (or 0 when costPrice is null). Operator's best
-- knowledge today; new receives append fresh layers from this point on.

CREATE TABLE IF NOT EXISTS "StockCostLayer" (
  "id"                TEXT NOT NULL,
  "productId"         TEXT NOT NULL,
  "variationId"       TEXT,
  "locationId"        TEXT,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unitCost"          DECIMAL(12,4) NOT NULL,
  "unitsReceived"     INTEGER NOT NULL,
  "unitsRemaining"    INTEGER NOT NULL,
  -- Landed-cost breakdown (per unit, in cents). All optional —
  -- legacy + WAC paths can leave them null.
  "freightCents"      INTEGER,
  "dutyCents"         INTEGER,
  "insuranceCents"    INTEGER,
  "brokerCents"       INTEGER,
  -- Source linkage. inboundShipmentId fires for PO receives;
  -- stockMovementId fires for synthetic / manual layers.
  "inboundShipmentId" TEXT,
  "stockMovementId"   TEXT,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockCostLayer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockCostLayer_productId_fkey" FOREIGN KEY ("productId")
    REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StockCostLayer_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- FIFO/LIFO consume hot path: by-product, ordered by receivedAt.
CREATE INDEX IF NOT EXISTS "StockCostLayer_productId_receivedAt_idx"
  ON "StockCostLayer"("productId", "receivedAt");
-- "Layers with stock" filter — partial-index alternative would be
-- cleaner but we keep the schema portable.
CREATE INDEX IF NOT EXISTS "StockCostLayer_productId_unitsRemaining_idx"
  ON "StockCostLayer"("productId", "unitsRemaining");
-- Sourcing audit.
CREATE INDEX IF NOT EXISTS "StockCostLayer_inboundShipmentId_idx"
  ON "StockCostLayer"("inboundShipmentId");
CREATE INDEX IF NOT EXISTS "StockCostLayer_stockMovementId_idx"
  ON "StockCostLayer"("stockMovementId");

-- Product additions.
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "costingMethod" TEXT NOT NULL DEFAULT 'WAC',
  ADD COLUMN IF NOT EXISTS "weightedAvgCostCents" INTEGER;

-- StockMovement.cogsCents — durable per-shipment COGS so reports
-- can read historical margin without replaying layers.
ALTER TABLE "StockMovement"
  ADD COLUMN IF NOT EXISTS "cogsCents" INTEGER;

-- Backfill: synthetic seed layers from current Product.totalStock.
-- One layer per (product, has stock); unitCost from costPrice; null
-- when costPrice is also null (legitimate — operator hasn't set it).
INSERT INTO "StockCostLayer" (
  "id", "productId", "receivedAt", "unitCost",
  "unitsReceived", "unitsRemaining", "notes"
)
SELECT
  'cl_seed_' || replace(gen_random_uuid()::text, '-', ''),
  p."id",
  CURRENT_TIMESTAMP,
  COALESCE(p."costPrice", 0),
  p."totalStock",
  p."totalStock",
  'S.20 backfill: synthetic seed from totalStock + costPrice snapshot'
FROM "Product" p
WHERE p."isParent" = false
  AND p."totalStock" > 0;

-- Backfill weightedAvgCostCents = costPrice for products with stock,
-- in case the cron / first-receive doesn't run before reports query.
UPDATE "Product"
SET "weightedAvgCostCents" = COALESCE(ROUND("costPrice" * 100), 0)
WHERE "isParent" = false
  AND "totalStock" > 0
  AND "weightedAvgCostCents" IS NULL;
