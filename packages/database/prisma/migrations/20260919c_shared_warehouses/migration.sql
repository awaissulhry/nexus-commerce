-- Shared stock plan step 4 — the borrower's copy of a lent warehouse's ADDRESS, the ship-from of orders
-- whose units came from a pool (services/stock-pool/shared-warehouses.ts). Plan:
-- docs/2026-09-19-shared-stock-plan.md §7; contract docs/2026-09-19-shared-stock-build.md §4. Additive
-- only: one nullable column and one unique index over it (every existing row is NULL; NULLs are distinct);
-- no row is written or moved. The doors that fill it are in packages/database/workspaces/stock-pool.sql
-- (migration 20260919a_stock_pool).

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "sharedFromLocationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_workspace_shared_from_key" ON "Warehouse"("workspaceId", "sharedFromLocationId");

