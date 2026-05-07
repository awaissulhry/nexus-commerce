-- CR.10 — per-warehouse default carrier account.
--
-- Wires CR.9's CarrierAccount rows into the print-label flow.
-- Warehouse.defaultCarrierAccountId is a SET NULL FK so deleting a
-- CarrierAccount doesn't cascade-destroy the warehouse — the
-- warehouse just falls back to the primary account.
--
-- print-label resolution order at the consumer side:
--   1. Warehouse.defaultCarrierAccountId → CarrierAccount creds
--   2. Carrier (primary) creds — existing behavior
--
-- Today only Sendcloud actually consults this; AMAZON_BUY_SHIPPING
-- + MANUAL paths ignore the warehouse account. The schema column
-- is generic for future carriers.

ALTER TABLE "Warehouse"
  ADD COLUMN IF NOT EXISTS "defaultCarrierAccountId" TEXT;

ALTER TABLE "Warehouse"
  DROP CONSTRAINT IF EXISTS "Warehouse_defaultCarrierAccountId_fkey";

ALTER TABLE "Warehouse"
  ADD CONSTRAINT "Warehouse_defaultCarrierAccountId_fkey"
  FOREIGN KEY ("defaultCarrierAccountId")
  REFERENCES "CarrierAccount"("id")
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "Warehouse_defaultCarrierAccountId_idx"
  ON "Warehouse" ("defaultCarrierAccountId");
