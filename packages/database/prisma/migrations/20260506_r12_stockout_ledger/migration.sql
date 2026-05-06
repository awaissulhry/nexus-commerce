-- =====================================================================
-- R.12 — Stockout ledger + lost-margin tracking
--
-- One row per "went to zero, came back" episode. Detection happens
-- both at movement time (synchronous hook in applyStockMovement) and
-- via a nightly cron safety net.
--
-- Partial unique index enforces "at most one OPEN event per
-- (productId, locationId)" at the DB layer — concurrent movements
-- can't double-open the same scope.
-- =====================================================================

CREATE TABLE "StockoutEvent" (
  "id"          TEXT NOT NULL,
  "productId"   TEXT NOT NULL,
  "sku"         TEXT NOT NULL,
  "locationId"  TEXT,
  "channel"     TEXT,
  "marketplace" TEXT,

  "startedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"     TIMESTAMP(3),
  "detectedBy"  TEXT NOT NULL,
  "closedBy"    TEXT,

  "velocityAtStart"    DECIMAL(10,2) NOT NULL,
  "marginCentsPerUnit" INTEGER,
  "unitCostCents"      INTEGER,
  "sellingPriceCents"  INTEGER,

  "durationDays"         DECIMAL(8,2),
  "estimatedLostUnits"   INTEGER,
  "estimatedLostRevenue" INTEGER,
  "estimatedLostMargin"  INTEGER,

  "notes" TEXT,

  CONSTRAINT "StockoutEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockoutEvent_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StockoutEvent_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "StockoutEvent_productId_startedAt_idx" ON "StockoutEvent"("productId", "startedAt");
CREATE INDEX "StockoutEvent_endedAt_idx" ON "StockoutEvent"("endedAt");
CREATE INDEX "StockoutEvent_sku_startedAt_idx" ON "StockoutEvent"("sku", "startedAt");

-- Partial unique: at most one OPEN event per (productId, locationId).
-- COALESCE handles the null-locationId case (treats null as a single
-- "global" key for that productId).
CREATE UNIQUE INDEX "StockoutEvent_one_open_per_scope"
  ON "StockoutEvent"("productId", COALESCE("locationId", '__global__'))
  WHERE "endedAt" IS NULL;
