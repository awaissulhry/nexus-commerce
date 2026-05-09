-- T.4 — Lift the locationId-required invariant from runtime check
-- (health-stock-invariants.mjs #6) to DB CHECK constraint.
--
-- All NEW StockMovement rows must carry a locationId, with one
-- exception preserved for the H.1 migration's parent-product
-- cleanup (10 historical rows from 2026-05-06). The exception
-- mirrors the existing health invariant so behavior is identical
-- but enforced at write time, not test time.

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_locationId_required"
  CHECK ("locationId" IS NOT NULL OR reason = 'PARENT_PRODUCT_CLEANUP');
