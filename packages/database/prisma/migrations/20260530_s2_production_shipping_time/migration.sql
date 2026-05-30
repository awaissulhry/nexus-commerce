-- S2 — split production + shipping time. Additive, online-safe: six nullable
-- INTEGER columns. Existing rows get NULL → effective lead time falls back to
-- the legacy leadTimeDays, so behavior is unchanged until values are entered.

ALTER TABLE "Supplier" ADD COLUMN "productionTimeDays" INTEGER;
ALTER TABLE "Supplier" ADD COLUMN "productionUnitsPerDay" INTEGER;
ALTER TABLE "Supplier" ADD COLUMN "shippingTimeDays" INTEGER;

ALTER TABLE "SupplierProduct" ADD COLUMN "productionTimeDaysOverride" INTEGER;
ALTER TABLE "SupplierProduct" ADD COLUMN "productionUnitsPerDayOverride" INTEGER;
ALTER TABLE "SupplierProduct" ADD COLUMN "shippingTimeDaysOverride" INTEGER;
