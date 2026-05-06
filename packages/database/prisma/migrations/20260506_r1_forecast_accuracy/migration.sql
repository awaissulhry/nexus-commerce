-- =====================================================================
-- R.1 — Forecast accuracy (MAPE) infrastructure
--
-- New table populated daily by a 04:00 UTC cron that compares each
-- prior-day forecast to its DailySalesAggregate actual. Pre-computes
-- absoluteError + percentError + withinBand per row so dashboards can
-- roll up MAPE / MAE / calibration with AVG() over date ranges.
--
-- percentError is nullable: MAPE is undefined on actualUnits=0 days,
-- but those rows are still stored so MAE (which uses absoluteError,
-- always defined) and bandCalibration roll up correctly.
-- =====================================================================

CREATE TABLE "ForecastAccuracy" (
  "id"                  TEXT NOT NULL,
  "sku"                 TEXT NOT NULL,
  "channel"             TEXT NOT NULL,
  "marketplace"         TEXT NOT NULL,
  "day"                 DATE NOT NULL,
  "forecastUnits"       DECIMAL(12,2) NOT NULL,
  "forecastLower80"     DECIMAL(12,2),
  "forecastUpper80"     DECIMAL(12,2),
  "actualUnits"         INTEGER NOT NULL,
  "absoluteError"       DECIMAL(12,2) NOT NULL,
  "percentError"        DECIMAL(7,2),
  "withinBand"          BOOLEAN NOT NULL,
  "modelRegime"         TEXT NOT NULL,
  "model"               TEXT NOT NULL,
  "forecastGeneratedAt" TIMESTAMP(3) NOT NULL,
  "evaluatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ForecastAccuracy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ForecastAccuracy_sku_channel_marketplace_day_key"
  ON "ForecastAccuracy"("sku","channel","marketplace","day");
CREATE INDEX "ForecastAccuracy_day_idx" ON "ForecastAccuracy"("day");
CREATE INDEX "ForecastAccuracy_modelRegime_idx" ON "ForecastAccuracy"("modelRegime");
CREATE INDEX "ForecastAccuracy_sku_day_idx" ON "ForecastAccuracy"("sku","day");
