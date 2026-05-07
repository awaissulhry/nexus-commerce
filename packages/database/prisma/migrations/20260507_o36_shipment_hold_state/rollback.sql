-- O.36 rollback. Run manually.

DROP INDEX IF EXISTS "Shipment_status_heldAt_idx";

ALTER TABLE "Shipment"
  DROP COLUMN IF EXISTS "heldAt",
  DROP COLUMN IF EXISTS "heldReason";

-- ShipmentStatusFBM enum value ON_HOLD remains; PG can't drop enum
-- values. Any rows that landed in ON_HOLD must be remapped first:
--   UPDATE "Shipment" SET status = 'DRAFT' WHERE status = 'ON_HOLD';
