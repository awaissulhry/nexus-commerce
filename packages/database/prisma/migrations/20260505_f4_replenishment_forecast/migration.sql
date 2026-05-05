-- F.4 — Replenishment forecast layer.
--
-- Two tables:
--   * ReplenishmentForecast: per-(sku, channel, marketplace, horizonDay)
--     prediction with confidence bands, written nightly by the forecast
--     worker (Holt-Winters + signal multipliers).
--   * RetailEvent: pre-known sales events that drive demand spikes;
--     read by the forecast worker as multiplicative factors on event
--     days. Sellers add custom events; starter set seeded separately.

CREATE TABLE "ReplenishmentForecast" (
  "id"             TEXT PRIMARY KEY,
  "sku"            TEXT NOT NULL,
  "channel"        TEXT NOT NULL,
  "marketplace"    TEXT NOT NULL,
  "horizonDay"     DATE NOT NULL,

  "forecastUnits"  DECIMAL(12, 2) NOT NULL,
  "lower80"        DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "upper80"        DECIMAL(12, 2) NOT NULL DEFAULT 0,

  "model"          TEXT NOT NULL DEFAULT 'HOLT_WINTERS_V1',
  "signals"        JSONB NOT NULL DEFAULT '{}',
  "generationTag"  TEXT,

  "generatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ReplenishmentForecast_sku_channel_marketplace_horizonDay_key"
  ON "ReplenishmentForecast" ("sku", "channel", "marketplace", "horizonDay");

CREATE INDEX "ReplenishmentForecast_sku_horizonDay_idx"
  ON "ReplenishmentForecast" ("sku", "horizonDay");

CREATE INDEX "ReplenishmentForecast_channel_marketplace_horizonDay_idx"
  ON "ReplenishmentForecast" ("channel", "marketplace", "horizonDay");

CREATE INDEX "ReplenishmentForecast_horizonDay_idx"
  ON "ReplenishmentForecast" ("horizonDay");

CREATE TABLE "RetailEvent" (
  "id"               TEXT PRIMARY KEY,
  "name"             TEXT NOT NULL,
  "startDate"        DATE NOT NULL,
  "endDate"          DATE NOT NULL,

  "channel"          TEXT,
  "marketplace"      TEXT,
  "productType"      TEXT,

  "expectedLift"     DECIMAL(4, 2) NOT NULL DEFAULT 1,
  "prepLeadTimeDays" INTEGER NOT NULL DEFAULT 30,

  "description"      TEXT,
  "source"           TEXT,
  "isActive"         BOOLEAN NOT NULL DEFAULT TRUE,

  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "RetailEvent_startDate_endDate_idx"
  ON "RetailEvent" ("startDate", "endDate");

CREATE INDEX "RetailEvent_channel_marketplace_idx"
  ON "RetailEvent" ("channel", "marketplace");

CREATE INDEX "RetailEvent_isActive_idx"
  ON "RetailEvent" ("isActive");
