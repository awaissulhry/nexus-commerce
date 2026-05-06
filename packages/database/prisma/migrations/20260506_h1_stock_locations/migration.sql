-- =====================================================================
-- H.1: Multi-location stock model
--
--   - StockLocation     (replaces single-Warehouse-as-stock-pool assumption)
--   - StockLevel        (per-location, per-product/variation quantity ledger)
--   - StockReservation  (24h TTL holds for PENDING orders)
--   - Extends StockMovement with locationId + transfer + source FKs
--   - Adds StockMovementReason values for SYNC_RECONCILIATION etc.
--
-- Pre-flight: NEXUS_ENABLE_AMAZON_INVENTORY_CRON must be set to 0 on
-- Railway BEFORE this migration runs. The FBA cron writes directly to
-- Product.totalStock today; running it concurrently with the backfill
-- (separate script, runs after this DDL) would create a race.
-- =====================================================================

-- ── 1. StockMovementReason enum extensions ──────────────────────────
-- Postgres requires ADD VALUE outside any prior usage in the same txn,
-- so we add them at the top before any code references them. These
-- statements implicitly commit; that's fine — DDL up to this point is
-- only enum extension and is self-contained.
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'SYNC_RECONCILIATION';
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'RESERVATION_CREATED';
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'RESERVATION_CONSUMED';
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'TRANSFER_IN';
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'PARENT_PRODUCT_CLEANUP';
ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'STOCKLEVEL_BACKFILL';

-- ── 2. StockLocation ────────────────────────────────────────────────
CREATE TABLE "StockLocation" (
  "id"                 TEXT         NOT NULL,
  "type"               TEXT         NOT NULL,
  "code"               TEXT         NOT NULL,
  "name"               TEXT         NOT NULL,
  "address"            JSONB,
  "isActive"           BOOLEAN      NOT NULL DEFAULT true,
  "servesMarketplaces" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "warehouseId"        TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockLocation_code_key"        ON "StockLocation"("code");
CREATE UNIQUE INDEX "StockLocation_warehouseId_key" ON "StockLocation"("warehouseId");
CREATE INDEX        "StockLocation_type_idx"        ON "StockLocation"("type");
CREATE INDEX        "StockLocation_isActive_idx"    ON "StockLocation"("isActive");

ALTER TABLE "StockLocation"
  ADD CONSTRAINT "StockLocation_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. StockLevel ───────────────────────────────────────────────────
CREATE TABLE "StockLevel" (
  "id"               TEXT         NOT NULL,
  "locationId"       TEXT         NOT NULL,
  "productId"        TEXT         NOT NULL,
  "variationId"      TEXT,
  "quantity"         INTEGER      NOT NULL DEFAULT 0,
  "reserved"         INTEGER      NOT NULL DEFAULT 0,
  "available"        INTEGER      NOT NULL DEFAULT 0,
  "reorderThreshold" INTEGER,
  "reorderQuantity"  INTEGER,
  "lastUpdatedAt"    TIMESTAMP(3) NOT NULL,
  "lastSyncedAt"     TIMESTAMP(3),
  "syncStatus"       TEXT         NOT NULL DEFAULT 'SYNCED',
  "syncError"        TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- Two partial UNIQUE indexes — one for variationId IS NULL, one for
-- variationId IS NOT NULL — give us "(location, product, variation)
-- is unique" semantics that work with Postgres' NULL-distinct rule.
CREATE UNIQUE INDEX "StockLevel_loc_prod_var_unique"
  ON "StockLevel"("locationId", "productId", "variationId")
  WHERE "variationId" IS NOT NULL;

CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique"
  ON "StockLevel"("locationId", "productId")
  WHERE "variationId" IS NULL;

CREATE INDEX "StockLevel_productId_idx"  ON "StockLevel"("productId");
CREATE INDEX "StockLevel_locationId_idx" ON "StockLevel"("locationId");
CREATE INDEX "StockLevel_quantity_idx"   ON "StockLevel"("quantity");
CREATE INDEX "StockLevel_syncStatus_idx" ON "StockLevel"("syncStatus");

ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_variationId_fkey"
  FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- DB-level invariants. The CHECK on `available` is the safety net for
-- the cached-column contract: any write that forgets to maintain it is
-- rejected at commit time.
ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_available_invariant"
  CHECK ("available" = "quantity" - "reserved");

ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_quantity_nonneg"  CHECK ("quantity" >= 0);

ALTER TABLE "StockLevel"
  ADD CONSTRAINT "StockLevel_reserved_nonneg"  CHECK ("reserved" >= 0);

-- ── 4. StockReservation ─────────────────────────────────────────────
CREATE TABLE "StockReservation" (
  "id"           TEXT         NOT NULL,
  "stockLevelId" TEXT         NOT NULL,
  "quantity"     INTEGER      NOT NULL,
  "orderId"      TEXT,
  "reason"       TEXT         NOT NULL,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "releasedAt"   TIMESTAMP(3),
  "consumedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockReservation_stockLevelId_idx"            ON "StockReservation"("stockLevelId");
CREATE INDEX "StockReservation_orderId_idx"                 ON "StockReservation"("orderId");
CREATE INDEX "StockReservation_expiresAt_idx"               ON "StockReservation"("expiresAt");
CREATE INDEX "StockReservation_releasedAt_consumedAt_idx"   ON "StockReservation"("releasedAt", "consumedAt");

ALTER TABLE "StockReservation"
  ADD CONSTRAINT "StockReservation_stockLevelId_fkey"
  FOREIGN KEY ("stockLevelId") REFERENCES "StockLevel"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StockReservation"
  ADD CONSTRAINT "StockReservation_quantity_positive"
  CHECK ("quantity" > 0);

-- ── 5. StockMovement extensions (additive, legacy cols preserved) ───
ALTER TABLE "StockMovement" ADD COLUMN "locationId"     TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "fromLocationId" TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "toLocationId"   TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "quantityBefore" INTEGER;
ALTER TABLE "StockMovement" ADD COLUMN "orderId"        TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "shipmentId"     TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "returnId"       TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "reservationId"  TEXT;

CREATE INDEX "StockMovement_locationId_createdAt_idx" ON "StockMovement"("locationId", "createdAt");
CREATE INDEX "StockMovement_orderId_idx"              ON "StockMovement"("orderId");
CREATE INDEX "StockMovement_shipmentId_idx"           ON "StockMovement"("shipmentId");
CREATE INDEX "StockMovement_returnId_idx"             ON "StockMovement"("returnId");

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_fromLocationId_fkey"
  FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_toLocationId_fkey"
  FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
