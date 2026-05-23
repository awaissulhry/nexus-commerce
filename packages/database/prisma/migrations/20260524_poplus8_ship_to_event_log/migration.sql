-- PO-Plus.8 — Drop-ship override + persisted PO event log.

-- Ship-to override on PurchaseOrder. JSON blob so future fields
-- (instructions, dropshipReference, etc.) land without migrations.
ALTER TABLE "PurchaseOrder"
  ADD COLUMN "shipToAddress" JSONB;

-- Persisted lifecycle audit. Mirrors every publishPoEvent emit so
-- the operator can grep history long after the in-process bus has
-- forgotten.
CREATE TABLE "PoEventLog" (
  "id"        TEXT NOT NULL,
  "poId"      TEXT,
  "poNumber"  TEXT,
  "type"      TEXT NOT NULL,
  "reason"    TEXT,
  "payload"   JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PoEventLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PoEventLog_poId_createdAt_idx" ON "PoEventLog"("poId", "createdAt");
CREATE INDEX "PoEventLog_type_createdAt_idx" ON "PoEventLog"("type", "createdAt");
CREATE INDEX "PoEventLog_createdAt_idx" ON "PoEventLog"("createdAt");
