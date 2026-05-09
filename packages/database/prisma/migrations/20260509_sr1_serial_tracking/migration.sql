-- SR.1 — Serial number tracking. Per-unit identification, complementary
-- to lot tracking (lot = batch, serial = individual unit).
--
-- Use cases for Xavia:
--   - Premium helmet warranty: each unit's manufacturer serial recorded
--     so warranty claims can be verified
--   - Counterfeit defense: serial scanned at receive + at outbound; the
--     pair confirms the same physical unit shipped
--   - Recall granularity beyond lot: when a recall cites specific
--     manufacturing-line serials within a batch, lot tracking is too
--     coarse — serial-level audit closes the gap
--
-- Lifecycle: AVAILABLE → RESERVED → SHIPPED → RETURNED → AVAILABLE
-- (returned units re-enter inventory) or → DISPOSED (write-off).
--
-- One row per (productId, serialNumber). Optional lot link so a unit
-- inherits its batch's recall state — when the lot is recalled, every
-- serial on that lot is flagged automatically.

CREATE TABLE "SerialNumber" (
  "id"             TEXT PRIMARY KEY,
  "productId"      TEXT NOT NULL,
  "variationId"    TEXT,
  "serialNumber"   TEXT NOT NULL,
  "lotId"          TEXT,
  "status"         TEXT NOT NULL DEFAULT 'AVAILABLE',
  "locationId"     TEXT,
  "receivedAt"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "shippedAt"      TIMESTAMP,
  "returnedAt"     TIMESTAMP,
  "disposedAt"     TIMESTAMP,
  "currentOrderId" TEXT,
  "currentShipmentId" TEXT,
  "lastReturnId"   TEXT,
  "manufacturerRef" TEXT,
  "notes"          TEXT,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SerialNumber_status_valid"
    CHECK ("status" IN ('AVAILABLE', 'RESERVED', 'SHIPPED', 'RETURNED', 'DISPOSED'))
);

CREATE UNIQUE INDEX "SerialNumber_product_serial_key"
  ON "SerialNumber"("productId", "serialNumber");
CREATE INDEX "SerialNumber_status_idx" ON "SerialNumber"("status");
CREATE INDEX "SerialNumber_lotId_idx" ON "SerialNumber"("lotId") WHERE "lotId" IS NOT NULL;
CREATE INDEX "SerialNumber_locationId_idx" ON "SerialNumber"("locationId") WHERE "locationId" IS NOT NULL;
CREATE INDEX "SerialNumber_currentOrderId_idx" ON "SerialNumber"("currentOrderId") WHERE "currentOrderId" IS NOT NULL;

ALTER TABLE "SerialNumber"
  ADD CONSTRAINT "SerialNumber_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SerialNumber"
  ADD CONSTRAINT "SerialNumber_variationId_fkey"
  FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SerialNumber"
  ADD CONSTRAINT "SerialNumber_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "Lot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SerialNumber"
  ADD CONSTRAINT "SerialNumber_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- StockMovement.serialNumberId — when a movement touched a specific
-- unit, the link survives forever (audit trail).
ALTER TABLE "StockMovement" ADD COLUMN "serialNumberId" TEXT;
ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_serialNumberId_fkey"
  FOREIGN KEY ("serialNumberId") REFERENCES "SerialNumber"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "StockMovement_serialNumberId_idx"
  ON "StockMovement"("serialNumberId") WHERE "serialNumberId" IS NOT NULL;
