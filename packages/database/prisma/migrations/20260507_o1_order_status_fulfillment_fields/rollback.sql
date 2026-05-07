-- O.1 rollback. Run manually — Prisma doesn't auto-execute rollback files.
--
-- Drop the columns first; the enum widening cannot be reversed cleanly
-- in PG (DROP VALUE doesn't exist), but the new values are inert if
-- nothing references them. Code that maps to them is reverted in the
-- code-side rollback (git revert of the matching commit).

DROP INDEX IF EXISTS "Order_shipByDate_idx";
DROP INDEX IF EXISTS "Order_status_shipByDate_idx";
DROP INDEX IF EXISTS "Order_isPrime_idx";

ALTER TABLE "Order"
  DROP COLUMN IF EXISTS "shipByDate",
  DROP COLUMN IF EXISTS "earliestShipDate",
  DROP COLUMN IF EXISTS "latestDeliveryDate",
  DROP COLUMN IF EXISTS "fulfillmentLatency",
  DROP COLUMN IF EXISTS "isPrime";

-- Note: enum values PROCESSING / PARTIALLY_SHIPPED / ON_HOLD /
-- AWAITING_PAYMENT / REFUNDED / RETURNED remain in OrderStatus.
-- Reverting them requires recreating the enum entirely. Any rows
-- written with new values during the rollback window must be
-- remapped first:
--   UPDATE "Order" SET status = 'PENDING'
--     WHERE status IN ('PROCESSING','PARTIALLY_SHIPPED','ON_HOLD','AWAITING_PAYMENT');
--   UPDATE "Order" SET status = 'CANCELLED'
--     WHERE status IN ('REFUNDED','RETURNED');
