-- =====================================================================
-- R.4 — Replenishment configuration: MOQ + case-pack + EOQ + safety
-- stock + per-product economics overrides.
--
-- All columns nullable / default-empty so the migration is additive.
-- The math service applies global defaults (95% service, 25% carrying
-- cost, €15 ordering cost) when these are null.
-- =====================================================================

-- ── SupplierProduct: case-pack constraint ──────────────────────────
ALTER TABLE "SupplierProduct" ADD COLUMN IF NOT EXISTS "casePack" INTEGER;

-- ── Product: replenishment economics overrides ────────────────────
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "serviceLevelPercent" DECIMAL(5,2);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "orderingCostCents"   INTEGER;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "carryingCostPctYear" DECIMAL(5,2);

-- ── ReplenishmentRecommendation: math snapshot for audit ───────────
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "safetyStockUnits"  INTEGER;
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "eoqUnits"          INTEGER;
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "constraintsApplied" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "unitCostCents"     INTEGER;
