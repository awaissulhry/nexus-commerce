-- Cycle count / physical inventory: structured count sessions with
-- per-item variance tracking + reconciliation via applyStockMovement.

CREATE TABLE IF NOT EXISTS "CycleCount" (
  "id"                 TEXT PRIMARY KEY,
  "locationId"         TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'DRAFT',
  "notes"              TEXT,
  "startedAt"          TIMESTAMP(3),
  "startedByUserId"    TEXT,
  "completedAt"        TIMESTAMP(3),
  "completedByUserId"  TEXT,
  "cancelledAt"        TIMESTAMP(3),
  "cancelledReason"    TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  "createdBy"          TEXT,
  CONSTRAINT "CycleCount_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CycleCount_locationId_status_idx"
  ON "CycleCount" ("locationId", "status");
CREATE INDEX IF NOT EXISTS "CycleCount_status_idx"
  ON "CycleCount" ("status");
CREATE INDEX IF NOT EXISTS "CycleCount_createdAt_idx"
  ON "CycleCount" ("createdAt" DESC);

CREATE TABLE IF NOT EXISTS "CycleCountItem" (
  "id"                    TEXT PRIMARY KEY,
  "cycleCountId"          TEXT NOT NULL,
  "productId"             TEXT NOT NULL,
  "variationId"           TEXT,
  "sku"                   TEXT NOT NULL,
  "expectedQuantity"      INTEGER NOT NULL,
  "countedQuantity"       INTEGER,
  "countedAt"             TIMESTAMP(3),
  "countedByUserId"       TEXT,
  "status"                TEXT NOT NULL DEFAULT 'PENDING',
  "reconciledMovementId"  TEXT,
  "reconciledAt"          TIMESTAMP(3),
  "reconciledByUserId"    TEXT,
  "notes"                 TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CycleCountItem_cycleCountId_fkey"
    FOREIGN KEY ("cycleCountId") REFERENCES "CycleCount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CycleCountItem_cycleCountId_status_idx"
  ON "CycleCountItem" ("cycleCountId", "status");
CREATE INDEX IF NOT EXISTS "CycleCountItem_productId_idx"
  ON "CycleCountItem" ("productId");
