-- F.1 — DailySalesAggregate fact table for the replenishment algorithm.
--
-- One row per (sku, channel, marketplace, day). Pre-aggregated so the
-- replenishment endpoint can read in milliseconds instead of GroupBy-ing
-- the full OrderItem table per request.
--
-- The unique constraint is on identity (sku, channel, marketplace, day);
-- `source` is metadata, NOT part of the key — when an SP-API report
-- arrives later it overwrites the OrderItem-derived row in place rather
-- than creating a duplicate.
--
-- Migration discipline (TECH_DEBT #37/#38):
--   - No `IF NOT EXISTS` on CREATE — silent-on-collision hides drift.
--   - Indexes added explicitly so the planner picks them up immediately.

CREATE TABLE "DailySalesAggregate" (
  "id"                  TEXT PRIMARY KEY,

  "sku"                 TEXT NOT NULL,
  "channel"             TEXT NOT NULL,
  "marketplace"         TEXT NOT NULL,
  "day"                 DATE NOT NULL,

  "unitsSold"           INTEGER NOT NULL DEFAULT 0,
  "grossRevenue"        DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "ordersCount"         INTEGER NOT NULL DEFAULT 0,

  "sessions"            INTEGER,
  "buyBoxPct"           DECIMAL(5, 2),
  "conversionRate"      DECIMAL(5, 4),
  "isStockOut"          BOOLEAN NOT NULL DEFAULT FALSE,
  "averageSellingPrice" DECIMAL(10, 2),

  "source"              TEXT NOT NULL DEFAULT 'ORDER_ITEM',

  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "DailySalesAggregate_sku_channel_marketplace_day_key"
  ON "DailySalesAggregate" ("sku", "channel", "marketplace", "day");

CREATE INDEX "DailySalesAggregate_sku_day_idx"
  ON "DailySalesAggregate" ("sku", "day");

CREATE INDEX "DailySalesAggregate_channel_marketplace_day_idx"
  ON "DailySalesAggregate" ("channel", "marketplace", "day");

CREATE INDEX "DailySalesAggregate_day_idx"
  ON "DailySalesAggregate" ("day");
