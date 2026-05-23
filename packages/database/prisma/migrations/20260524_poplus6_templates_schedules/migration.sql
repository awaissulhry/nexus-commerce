-- PO-Plus.6 — Reusable PO templates + recurring schedules.

CREATE TABLE "PoTemplate" (
  "id"           TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "supplierId"   TEXT,
  "warehouseId"  TEXT,
  "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
  "notes"        TEXT,
  "createdBy"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "deletedAt"    TIMESTAMP(3),

  CONSTRAINT "PoTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PoTemplate_supplierId_idx" ON "PoTemplate"("supplierId");
CREATE INDEX "PoTemplate_deletedAt_idx" ON "PoTemplate"("deletedAt");
CREATE INDEX "PoTemplate_createdAt_idx" ON "PoTemplate"("createdAt");

ALTER TABLE "PoTemplate"
  ADD CONSTRAINT "PoTemplate_supplierId_fkey"
  FOREIGN KEY ("supplierId")
  REFERENCES "Supplier"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PoTemplate"
  ADD CONSTRAINT "PoTemplate_warehouseId_fkey"
  FOREIGN KEY ("warehouseId")
  REFERENCES "Warehouse"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PoTemplateItem" (
  "id"              TEXT NOT NULL,
  "templateId"      TEXT NOT NULL,
  "productId"       TEXT,
  "supplierSku"     TEXT,
  "sku"             TEXT NOT NULL,
  "quantityOrdered" INTEGER NOT NULL,
  "unitCostCents"   INTEGER NOT NULL DEFAULT 0,
  "note"            TEXT,
  "lineOrder"       INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "PoTemplateItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PoTemplateItem_templateId_lineOrder_idx"
  ON "PoTemplateItem"("templateId", "lineOrder");

ALTER TABLE "PoTemplateItem"
  ADD CONSTRAINT "PoTemplateItem_templateId_fkey"
  FOREIGN KEY ("templateId")
  REFERENCES "PoTemplate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PoSchedule" (
  "id"                TEXT NOT NULL,
  "templateId"        TEXT NOT NULL,
  "cadence"           TEXT NOT NULL,
  "cadenceInterval"   INTEGER NOT NULL DEFAULT 1,
  "startsAt"          TIMESTAMP(3) NOT NULL,
  "nextRunAt"         TIMESTAMP(3) NOT NULL,
  "lastRunAt"         TIMESTAMP(3),
  "lastGeneratedPoId" TEXT,
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "expectedLeadDays"  INTEGER,
  "createdBy"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PoSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PoSchedule_nextRunAt_isActive_idx"
  ON "PoSchedule"("nextRunAt", "isActive");
CREATE INDEX "PoSchedule_templateId_idx" ON "PoSchedule"("templateId");

ALTER TABLE "PoSchedule"
  ADD CONSTRAINT "PoSchedule_templateId_fkey"
  FOREIGN KEY ("templateId")
  REFERENCES "PoTemplate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
