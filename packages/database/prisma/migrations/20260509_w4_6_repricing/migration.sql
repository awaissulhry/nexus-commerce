-- W4.6 — RepricingRule + RepricingDecision (Rithum cornerstone).
--
-- Per-(product, channel, marketplace) repricing config + append-
-- only audit log of engine decisions. The repricing engine
-- (W4.7+) reads RepricingRule rows on each tick + decides what
-- price to push, logging every decision in RepricingDecision so
-- the operator can answer "why did my price drop yesterday at
-- 14:00?" by reading the decision history.
--
-- Strategies (string enum): match_buy_box | beat_lowest_by_pct |
-- beat_lowest_by_amount | fixed_to_buy_box_minus | manual.
--
-- Floor/ceiling are HARD constraints — every strategy clamps to
-- [minPrice, maxPrice]. A clamp is logged as `capped` on the
-- decision row.
--
-- Cascade rules:
--   Product → RepricingRule           : CASCADE
--   RepricingRule → RepricingDecision : CASCADE
--
-- Idempotent (IF NOT EXISTS + pg_constraint guards).

-- ── RepricingRule ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RepricingRule" (
  "id"                 TEXT NOT NULL,
  "productId"          TEXT NOT NULL,
  "channel"            TEXT NOT NULL,
  "marketplace"        TEXT,
  "enabled"            BOOLEAN NOT NULL DEFAULT TRUE,
  "minPrice"           DECIMAL(10, 2) NOT NULL,
  "maxPrice"           DECIMAL(10, 2) NOT NULL,
  "strategy"           TEXT NOT NULL,
  "beatPct"            DECIMAL(5, 2),
  "beatAmount"         DECIMAL(10, 2),
  "activeFromHour"     INTEGER,
  "activeToHour"       INTEGER,
  "activeDays"         INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "notes"              TEXT,
  "lastEvaluatedAt"    TIMESTAMP,
  "lastDecisionPrice"  DECIMAL(10, 2),
  "lastDecisionReason" TEXT,
  "createdAt"          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP NOT NULL,

  CONSTRAINT "RepricingRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RepricingRule_productId_channel_marketplace_key"
  ON "RepricingRule"("productId", "channel", "marketplace");

CREATE INDEX IF NOT EXISTS "RepricingRule_productId_idx"
  ON "RepricingRule"("productId");

CREATE INDEX IF NOT EXISTS "RepricingRule_channel_marketplace_idx"
  ON "RepricingRule"("channel", "marketplace");

CREATE INDEX IF NOT EXISTS "RepricingRule_enabled_idx"
  ON "RepricingRule"("enabled");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RepricingRule_productId_fkey'
  ) THEN
    ALTER TABLE "RepricingRule"
      ADD CONSTRAINT "RepricingRule_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── RepricingDecision ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RepricingDecision" (
  "id"              TEXT NOT NULL,
  "ruleId"          TEXT NOT NULL,
  "oldPrice"        DECIMAL(10, 2) NOT NULL,
  "newPrice"        DECIMAL(10, 2) NOT NULL,
  "reason"          TEXT NOT NULL,
  "buyBoxPrice"     DECIMAL(10, 2),
  "lowestCompPrice" DECIMAL(10, 2),
  "competitorCount" INTEGER,
  "applied"         BOOLEAN NOT NULL,
  "capped"          TEXT,
  "createdAt"       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RepricingDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RepricingDecision_ruleId_createdAt_idx"
  ON "RepricingDecision"("ruleId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RepricingDecision_ruleId_fkey'
  ) THEN
    ALTER TABLE "RepricingDecision"
      ADD CONSTRAINT "RepricingDecision_ruleId_fkey"
      FOREIGN KEY ("ruleId") REFERENCES "RepricingRule"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
