-- =====================================================================
-- ROLLBACK for 20260506_h1_stock_locations
--
-- Use only if Commit 1 fails verification and we need to undo.
-- Two halves:
--   PART A: data-side rollback (only needed if backfill-stocklevel.mjs
--           ran). Restores Product.totalStock from the audit rows it
--           wrote. Run THIS FIRST.
--   PART B: DDL rollback. Drops new tables, removes new StockMovement
--           columns. Enum values cannot be DROP VALUE'd in Postgres —
--           the seven new StockMovementReason values stay in the type
--           forever. This is benign (they just become unused).
-- =====================================================================

-- ─── PART A: data-side rollback ──────────────────────────────────────
-- Skip this section if the backfill never ran successfully.

BEGIN;

-- A1. Restore parent product totalStock from the cleanup audit row.
-- Each PARENT_PRODUCT_CLEANUP movement has change = -original_stock,
-- so multiplying by -1 recovers the pre-backfill value.
UPDATE "Product" p
SET "totalStock" = (-1) * sm."change"
FROM "StockMovement" sm
WHERE sm."referenceType" = 'PARENT_PRODUCT_CLEANUP'
  AND sm."actor" = 'system:migration_h1_stock_locations'
  AND sm."productId" = p."id"
  AND p."isParent" = true;

-- A2. Recompute Product.totalStock for buyable products from the
-- STOCKLEVEL_BACKFILL audit rows. Each one was written with
-- change = original_stock for its (product, IT-MAIN) StockLevel.
UPDATE "Product" p
SET "totalStock" = COALESCE((
  SELECT SUM(sm."change")
  FROM "StockMovement" sm
  WHERE sm."referenceType" = 'STOCKLEVEL_BACKFILL'
    AND sm."actor" = 'system:migration_h1_stock_locations'
    AND sm."productId" = p."id"
), 0)
WHERE p."isParent" = false;

-- A3. Delete every audit row this migration wrote.
DELETE FROM "StockMovement"
WHERE "actor" = 'system:migration_h1_stock_locations';

COMMIT;

-- ─── PART B: DDL rollback ────────────────────────────────────────────
BEGIN;

-- B1. Drop StockMovement extensions
DROP INDEX IF EXISTS "StockMovement_locationId_createdAt_idx";
DROP INDEX IF EXISTS "StockMovement_orderId_idx";
DROP INDEX IF EXISTS "StockMovement_shipmentId_idx";
DROP INDEX IF EXISTS "StockMovement_returnId_idx";

ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_locationId_fkey";
ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_fromLocationId_fkey";
ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_toLocationId_fkey";

ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "locationId";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "fromLocationId";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "toLocationId";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "quantityBefore";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "orderId";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "shipmentId";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "returnId";
ALTER TABLE "StockMovement" DROP COLUMN IF EXISTS "reservationId";

-- B2. Drop new tables (cascade handles indexes, constraints, FKs)
DROP TABLE IF EXISTS "StockReservation";
DROP TABLE IF EXISTS "StockLevel";
DROP TABLE IF EXISTS "StockLocation";

-- B3. Mark migration as not-applied so prisma migrate resolves cleanly
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260506_h1_stock_locations';

COMMIT;
