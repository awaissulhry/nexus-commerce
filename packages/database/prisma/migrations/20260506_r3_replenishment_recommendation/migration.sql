-- =====================================================================
-- R.3 — Replenishment recommendation persistence + audit trail
--
-- One row per recommendation ever shown for a product. Status machine:
--   ACTIVE → SUPERSEDED (replaced by newer rec)
--   ACTIVE → ACTED (operator created PO/WO)
--   ACTIVE → DISMISSED (R.5 polish exposes this action)
--
-- The partial unique index enforces "at most one ACTIVE per productId"
-- at the DB layer, so concurrent writes can't both insert ACTIVE rows
-- for the same product and hide a race.
-- =====================================================================

CREATE TABLE "ReplenishmentRecommendation" (
  "id"                   TEXT NOT NULL,
  "productId"            TEXT NOT NULL,
  "sku"                  TEXT NOT NULL,
  "generatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "velocity"             DECIMAL(10,2) NOT NULL,
  "velocitySource"       TEXT NOT NULL,
  "leadTimeDays"         INTEGER NOT NULL,
  "leadTimeSource"       TEXT NOT NULL,
  "safetyDays"           INTEGER NOT NULL,

  "totalAvailable"        INTEGER NOT NULL,
  "inboundWithinLeadTime" INTEGER NOT NULL,
  "effectiveStock"        INTEGER NOT NULL,

  "reorderPoint"         INTEGER NOT NULL,
  "reorderQuantity"      INTEGER NOT NULL,
  "daysOfStockLeft"      INTEGER,
  "urgency"              TEXT NOT NULL,
  "needsReorder"         BOOLEAN NOT NULL,

  "preferredSupplierId"  TEXT,
  "isManufactured"       BOOLEAN NOT NULL DEFAULT false,

  "status"               TEXT NOT NULL DEFAULT 'ACTIVE',
  "supersededAt"         TIMESTAMP(3),
  "supersededById"       TEXT,
  "actedAt"              TIMESTAMP(3),
  "actedByUserId"        TEXT,
  "resultingPoId"        TEXT,
  "resultingWorkOrderId" TEXT,

  "overrideQuantity"     INTEGER,
  "overrideNotes"        TEXT,
  "overrideByUserId"     TEXT,

  CONSTRAINT "ReplenishmentRecommendation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplenishmentRecommendation_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ReplenishmentRecommendation_productId_status_idx"
  ON "ReplenishmentRecommendation"("productId", "status");
CREATE INDEX "ReplenishmentRecommendation_generatedAt_idx"
  ON "ReplenishmentRecommendation"("generatedAt");
CREATE INDEX "ReplenishmentRecommendation_urgency_status_idx"
  ON "ReplenishmentRecommendation"("urgency", "status");
CREATE INDEX "ReplenishmentRecommendation_resultingPoId_idx"
  ON "ReplenishmentRecommendation"("resultingPoId");

-- Partial unique: at most one ACTIVE per productId. Prisma doesn't
-- model partial indexes, but the migration is authoritative + the
-- index participates in conflict resolution as expected.
CREATE UNIQUE INDEX "ReplenishmentRecommendation_one_active_per_product"
  ON "ReplenishmentRecommendation"("productId")
  WHERE "status" = 'ACTIVE';
