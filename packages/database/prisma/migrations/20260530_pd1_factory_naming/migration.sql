-- PD.1 — factory-facing product naming. Additive only: nullable columns
-- on SupplierProduct (per-supplier default) + PurchaseOrderItem (per-line
-- override). No backfill, no destructive changes.

ALTER TABLE "SupplierProduct" ADD COLUMN "factoryName" TEXT;
ALTER TABLE "SupplierProduct" ADD COLUMN "factorySize" TEXT;
ALTER TABLE "SupplierProduct" ADD COLUMN "factorySpec" TEXT;

ALTER TABLE "PurchaseOrderItem" ADD COLUMN "factoryName" TEXT;
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "factorySize" TEXT;
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "factorySpec" TEXT;
