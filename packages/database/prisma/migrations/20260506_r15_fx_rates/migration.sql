-- =====================================================================
-- R.15 — FX-aware EOQ + multi-currency PO totals
--
-- Reuses the existing FxRate table + fx-rate.service.ts from G.2
-- (pricing engine). R.15 only adds audit columns to
-- ReplenishmentRecommendation so we can answer "what FX rate did we
-- apply when generating this rec?" months later.
--
-- Replenishment math service grows a currency-aware unitCost path:
-- when SupplierProduct.currencyCode != 'EUR', the engine pulls the
-- cached rate via getFxRate() and converts to EUR-cents before
-- feeding into eoq().
-- =====================================================================

ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "unitCostCurrency" TEXT;
ALTER TABLE "ReplenishmentRecommendation" ADD COLUMN IF NOT EXISTS "fxRateUsed"       DECIMAL(14,6);
