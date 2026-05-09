-- L.1 — Lot tracking schema (NetSuite-tier).
--
-- Required for Xavia's motorcycle helmet category: EU GPSR (in force
-- Dec 2024) makes manufacturers and distributors of safety equipment
-- liable for recall traceability. Without lot tracking we can't:
--   - Identify which units came from a specific factory batch
--   - Find which orders shipped affected lots (forward trace)
--   - Find which inbound receipt supplied a lot (backward trace)
--   - Selectively suppress remaining sellable when a recall opens
--
-- Schema design:
--   Lot: header row per (productId, lotNumber). lotNumber is operator-
--        supplied at receive time (matches the supplier's batch label).
--        expiresAt is optional — useful for FEFO consumption when set.
--        unitsReceived is the lifetime total; unitsRemaining drops on
--        consume. Origin links capture provenance for backward trace.
--
--   StockMovement.lotId: optional FK so consume / receive movements
--        can record which lot was touched. Forward trace = list
--        movements where lotId = X.
--
--   StockCostLayer.lotId: optional FK so a receive that creates both
--        a cost layer AND a lot can carry the linkage. Lets the
--        valuation report break down by lot when needed.

CREATE TABLE "Lot" (
  "id"                    TEXT PRIMARY KEY,
  "productId"             TEXT NOT NULL,
  "variationId"           TEXT,
  "lotNumber"             TEXT NOT NULL,
  "receivedAt"            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"             TIMESTAMP,
  "unitsReceived"         INTEGER NOT NULL,
  "unitsRemaining"        INTEGER NOT NULL,
  "originPoId"            TEXT,
  "originInboundShipmentId" TEXT,
  "originStockMovementId" TEXT,
  "supplierLotRef"        TEXT,
  "notes"                 TEXT,
  "createdAt"             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Lot_unitsRemaining_nonneg" CHECK ("unitsRemaining" >= 0),
  CONSTRAINT "Lot_unitsRemaining_le_received" CHECK ("unitsRemaining" <= "unitsReceived")
);

-- Lot numbers are unique per product (one supplier batch label can't
-- collide with itself for the same product). Variants share the
-- parent's lot space deliberately — a lot is a manufacturing batch.
CREATE UNIQUE INDEX "Lot_product_lotNumber_key"
  ON "Lot"("productId", "lotNumber");
CREATE INDEX "Lot_product_receivedAt_idx" ON "Lot"("productId", "receivedAt");
CREATE INDEX "Lot_expiresAt_idx" ON "Lot"("expiresAt") WHERE "expiresAt" IS NOT NULL;
CREATE INDEX "Lot_unitsRemaining_idx" ON "Lot"("productId", "unitsRemaining") WHERE "unitsRemaining" > 0;

ALTER TABLE "Lot"
  ADD CONSTRAINT "Lot_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lot"
  ADD CONSTRAINT "Lot_variationId_fkey"
  FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Optional FK linkage for forward/backward trace. SET NULL on origin
-- delete because losing the origin shouldn't orphan the lot record.
ALTER TABLE "Lot"
  ADD CONSTRAINT "Lot_originStockMovementId_fkey"
  FOREIGN KEY ("originStockMovementId") REFERENCES "StockMovement"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- StockMovement.lotId — which lot a movement touched. Optional.
ALTER TABLE "StockMovement" ADD COLUMN "lotId" TEXT;
ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "Lot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "StockMovement_lotId_idx" ON "StockMovement"("lotId") WHERE "lotId" IS NOT NULL;

-- StockCostLayer.lotId — receive-time linkage when a layer + lot are
-- both created from the same inbound. Lets the valuation report
-- break down rimanenze by lot for compliance audits.
ALTER TABLE "StockCostLayer" ADD COLUMN "lotId" TEXT;
ALTER TABLE "StockCostLayer"
  ADD CONSTRAINT "StockCostLayer_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "Lot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "StockCostLayer_lotId_idx" ON "StockCostLayer"("lotId") WHERE "lotId" IS NOT NULL;
