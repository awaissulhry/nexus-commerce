-- O.36 — Hold-for-review state on Shipment.
--
-- The shipping rules engine (O.16) has a holdForReview action but no
-- consumer or UI today. This migration adds:
--   1. ON_HOLD value to ShipmentStatusFBM enum.
--   2. heldAt + heldReason columns on Shipment for audit + the
--      holds-queue UI.
--
-- The holds queue tab (O.36 frontend) reads Shipment WHERE status =
-- 'ON_HOLD' and lets operator review + release each. Bulk-create-
-- shipments (with an active rule whose actions.holdForReview = true)
-- writes status='ON_HOLD' + heldAt=now + heldReason='Auto-held by
-- rule {ruleName}'.
--
-- Pattern matches D.1's enum widening — ADD VALUE IF NOT EXISTS for
-- non-breaking deploys; ADD COLUMN IF NOT EXISTS for the new fields.

ALTER TYPE "ShipmentStatusFBM" ADD VALUE IF NOT EXISTS 'ON_HOLD';

ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "heldAt"     TIMESTAMP(3);
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "heldReason" TEXT;

-- Index for the holds-queue list read. Composite (status, heldAt)
-- without a WHERE clause — PG forbids new enum values in same-tx
-- WHERE predicates ("New enum values must be committed before they
-- can be used"). The composite is selective enough on the existing
-- (status) index for v0; if the holds queue grows substantially a
-- follow-up migration can ADD a partial index in its own tx.
CREATE INDEX IF NOT EXISTS "Shipment_status_heldAt_idx"
  ON "Shipment"("status", "heldAt");
