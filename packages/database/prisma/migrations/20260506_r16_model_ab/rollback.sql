-- Rollback for R.16 model A/B
DROP TABLE IF EXISTS "ForecastModelAssignment";

DROP INDEX IF EXISTS "ReplenishmentForecast_sku_channel_marketplace_horizonDay_model_key";
CREATE UNIQUE INDEX "ReplenishmentForecast_sku_channel_marketplace_horizonDay_key"
  ON "ReplenishmentForecast"("sku", "channel", "marketplace", "horizonDay");
