-- =====================================================================
-- R.16 — Forecast model A/B (champion-challenger)
--
-- Two changes:
--   1. ReplenishmentForecast unique key extended to include `model`
--      so champion + challenger can both write rows for the same
--      (sku, channel, marketplace, day) tuple.
--   2. New ForecastModelAssignment table maps SKU → assigned model.
--      Multiple rows per SKU allowed (one per cohort).
--
-- Migration safety: every existing ReplenishmentForecast row already
-- has model='HOLT_WINTERS_V1' (default since R.1). Adding `model` to
-- the unique key produces zero conflicts on existing data.
-- =====================================================================

-- ── ReplenishmentForecast unique extension ────────────────────────
ALTER TABLE "ReplenishmentForecast"
  DROP CONSTRAINT IF EXISTS "ReplenishmentForecast_sku_channel_marketplace_horizonDay_key";
DROP INDEX IF EXISTS "ReplenishmentForecast_sku_channel_marketplace_horizonDay_key";

CREATE UNIQUE INDEX "ReplenishmentForecast_sku_channel_marketplace_horizonDay_model_key"
  ON "ReplenishmentForecast"("sku", "channel", "marketplace", "horizonDay", "model");

-- ── ForecastModelAssignment ──────────────────────────────────────
CREATE TABLE "ForecastModelAssignment" (
  "id"         TEXT NOT NULL,
  "sku"        TEXT NOT NULL,
  "modelId"    TEXT NOT NULL,
  "cohort"     TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedBy" TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3),

  CONSTRAINT "ForecastModelAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ForecastModelAssignment_sku_modelId_key" ON "ForecastModelAssignment"("sku", "modelId");
CREATE INDEX "ForecastModelAssignment_modelId_idx" ON "ForecastModelAssignment"("modelId");
CREATE INDEX "ForecastModelAssignment_cohort_idx" ON "ForecastModelAssignment"("cohort");
CREATE INDEX "ForecastModelAssignment_sku_idx"    ON "ForecastModelAssignment"("sku");
