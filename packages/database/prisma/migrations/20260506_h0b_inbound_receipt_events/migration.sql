-- =====================================================================
-- H.0b — InboundReceipt event log + idempotency
--
-- Pre-roadmap correctness fix for the receive double-stock bug.
-- InboundReceipt becomes the source of truth for receive history;
-- InboundShipmentItem.quantityReceived becomes a cached SUM.
-- =====================================================================

CREATE TABLE "InboundReceipt" (
  "id"                    TEXT         NOT NULL,
  "inboundShipmentItemId" TEXT         NOT NULL,
  "quantity"              INTEGER      NOT NULL,
  "qcStatus"              TEXT,
  "qcNotes"               TEXT,
  "notes"                 TEXT,
  "idempotencyKey"        TEXT,
  "stockMovementId"       TEXT,
  "receivedBy"            TEXT,
  "receivedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundReceipt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InboundReceipt_inboundShipmentItemId_idx" ON "InboundReceipt"("inboundShipmentItemId");
CREATE INDEX "InboundReceipt_receivedAt_idx"            ON "InboundReceipt"("receivedAt");
CREATE INDEX "InboundReceipt_idempotencyKey_idx"        ON "InboundReceipt"("idempotencyKey");

-- Partial unique: enforce one receipt per (item, idempotencyKey) only
-- when idempotencyKey is set. Postgres' default NULL-distinct semantics
-- for the simple @@unique would fail us — we want NULL keys to repeat
-- (a UI without a key still works, just without explicit retry
-- protection; cumulative-target semantics in the route protect it).
CREATE UNIQUE INDEX "InboundReceipt_item_idempotency_unique"
  ON "InboundReceipt"("inboundShipmentItemId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

ALTER TABLE "InboundReceipt"
  ADD CONSTRAINT "InboundReceipt_inboundShipmentItemId_fkey"
  FOREIGN KEY ("inboundShipmentItemId") REFERENCES "InboundShipmentItem"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariant: zero-quantity events never persist. The receive route
-- short-circuits before insert; this CHECK is belt-and-braces.
ALTER TABLE "InboundReceipt"
  ADD CONSTRAINT "InboundReceipt_quantity_nonzero"
  CHECK ("quantity" <> 0);
