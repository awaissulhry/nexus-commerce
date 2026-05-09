-- BN.1 — Bin management within StockLocation. Bin = physical
-- subdivision (shelf, pallet slot, zone) inside a warehouse. For
-- Riccione: lets the operator pick by bin code instead of "look
-- through the whole warehouse for AGV-K1-RED-XL".
--
-- Bins belong to one StockLocation. (locationId, code) unique within
-- a location. Optional zone groups bins by area ("RECEIVING",
-- "PICKING", "OVERFLOW", "QC-HOLD"). Capacity is informational —
-- not enforced — for over-fill warnings in the UI.

CREATE TABLE "StockBin" (
  "id"            TEXT PRIMARY KEY,
  "locationId"    TEXT NOT NULL,
  "code"          TEXT NOT NULL,
  "name"          TEXT,
  "zone"          TEXT,
  "binType"       TEXT,
  "capacity"      INTEGER,
  "isActive"      BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "StockBin_location_code_key"
  ON "StockBin"("locationId", "code");
CREATE INDEX "StockBin_location_zone_idx" ON "StockBin"("locationId", "zone");
CREATE INDEX "StockBin_active_idx" ON "StockBin"("isActive") WHERE "isActive" = TRUE;

ALTER TABLE "StockBin"
  ADD CONSTRAINT "StockBin_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-(stocklevel × bin) quantity ledger. A StockLevel total can
-- spread across multiple bins. Sum of StockBinQuantity.quantity for
-- a StockLevel must equal StockLevel.quantity (invariant verified in
-- the health-stock-invariants script).
CREATE TABLE "StockBinQuantity" (
  "id"           TEXT PRIMARY KEY,
  "stockLevelId" TEXT NOT NULL,
  "binId"        TEXT NOT NULL,
  "quantity"     INTEGER NOT NULL DEFAULT 0,
  "lastUpdatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockBinQuantity_quantity_nonneg" CHECK ("quantity" >= 0)
);

CREATE UNIQUE INDEX "StockBinQuantity_stockLevel_bin_key"
  ON "StockBinQuantity"("stockLevelId", "binId");
CREATE INDEX "StockBinQuantity_binId_idx" ON "StockBinQuantity"("binId");

ALTER TABLE "StockBinQuantity"
  ADD CONSTRAINT "StockBinQuantity_stockLevelId_fkey"
  FOREIGN KEY ("stockLevelId") REFERENCES "StockLevel"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StockBinQuantity"
  ADD CONSTRAINT "StockBinQuantity_binId_fkey"
  FOREIGN KEY ("binId") REFERENCES "StockBin"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- StockMovement.binId — when a movement was posted into/out of a
-- specific bin (vs the location-aggregate ledger). Optional.
ALTER TABLE "StockMovement" ADD COLUMN "binId" TEXT;
ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_binId_fkey"
  FOREIGN KEY ("binId") REFERENCES "StockBin"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "StockMovement_binId_idx"
  ON "StockMovement"("binId") WHERE "binId" IS NOT NULL;
