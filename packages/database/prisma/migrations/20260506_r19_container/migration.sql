-- R.19 — container / shipping cost optimization.
-- Adds SupplierShippingProfile (one row per supplier) + landed-cost
-- audit columns on ReplenishmentRecommendation.

CREATE TABLE "SupplierShippingProfile" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "costPerCbmCents" INTEGER,
    "costPerKgCents" INTEGER,
    "fixedCostCents" INTEGER,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "containerCapacityCbm" DECIMAL(8,2),
    "containerMaxWeightKg" DECIMAL(10,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierShippingProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierShippingProfile_supplierId_key"
  ON "SupplierShippingProfile"("supplierId");

CREATE INDEX "SupplierShippingProfile_supplierId_idx"
  ON "SupplierShippingProfile"("supplierId");

ALTER TABLE "SupplierShippingProfile"
  ADD CONSTRAINT "SupplierShippingProfile_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReplenishmentRecommendation"
  ADD COLUMN "freightCostPerUnitCents" INTEGER,
  ADD COLUMN "landedCostPerUnitCents" INTEGER;
