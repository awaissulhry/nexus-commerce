-- Phase 1 — Amazon Ads Brand Metrics, modelled on the LIVE contract.
--
-- The pre-existing AmazonAdsBrandMetric table was built against a guess:
-- searchImpressionShare / brandSearches / brandConversionShare / categoryRank.
-- None of those fields exist in Amazon's response. Captured live from the IT
-- profile on 2026-07-29, GET /insights/brandMetrics/report/{id} returns:
--
--   { "brandBuildingMetrics": [ { "metadata": {...}, "metrics": {...} } ] }
--
-- with a brand-funnel metric set (awareness / consideration / sales indices,
-- brand customers, add-to-carts, branded searches, detail-page views) AND a
-- category median + top-performer benchmark beside nearly every metric.
--
-- Two contract facts encoded here:
--   · Every metric value arrives as a STRING ("12", "0.6668"), so the raw map
--     is stored as JSONB verbatim and only the charted indices are promoted to
--     typed columns.
--   · aggregationLevel is IGNORED by Amazon — DAILY / WEEKLY / MONTHLY all
--     returned byte-identical payloads with lookbackPeriod='1w'. The grain is
--     always weekly, which is why lookbackPeriod is part of the unique key
--     rather than a request parameter we pretend to control.
--
-- ADDITIVE. The old AmazonAdsBrandMetric table is left in place and untouched;
-- it holds 0 rows and nothing reads it. Dropping it is a destructive migration
-- and is deliberately NOT done here.

CREATE TABLE IF NOT EXISTS "AmazonAdsBrandBuildingMetric" (
  "id"                                TEXT PRIMARY KEY,
  "profileId"                         TEXT NOT NULL,
  "marketplace"                       TEXT NOT NULL,
  "brandName"                         TEXT NOT NULL,
  "brandId"                           TEXT,

  "computationDate"                   DATE NOT NULL,
  "lookbackPeriod"                    TEXT NOT NULL DEFAULT '1w',
  "categoryNodeName"                  TEXT,
  "categoryNodeTreeName"              TEXT,

  -- Full metric map exactly as Amazon sent it (values remain strings), so a
  -- metric Amazon adds later is captured with no migration and no data loss.
  "metrics"                           JSONB NOT NULL,

  -- Promoted columns for the charted funnel. All NULLable on purpose: Amazon
  -- omits metrics it cannot compute, and 0 is a REAL value for every one of
  -- these, so "absent" must never collapse into "zero".
  "awarenessIndex"                    DECIMAL(12,4),
  "considerationIndex"                DECIMAL(12,4),
  "salesIndex"                        DECIMAL(12,4),
  "brandCustomers"                    INTEGER,
  "highValueCustomers"                INTEGER,
  "addToCarts"                        INTEGER,
  "viewedDetailPageOnly"              INTEGER,
  "brandedSearchesOnly"               INTEGER,
  "brandedSearchesAndDetailPageViews" INTEGER,
  "newToBrandCustomerRate"            DECIMAL(12,4),
  "customerConversionRate"            DECIMAL(12,4),

  "reportedAt"                        TIMESTAMP(3) NOT NULL,
  "createdAt"                         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AmazonAdsBrandBuildingMetric_profile_brand_date_lookback_key"
  ON "AmazonAdsBrandBuildingMetric" ("profileId", "brandName", "computationDate", "lookbackPeriod");

CREATE INDEX IF NOT EXISTS "AmazonAdsBrandBuildingMetric_profileId_computationDate_idx"
  ON "AmazonAdsBrandBuildingMetric" ("profileId", "computationDate");

CREATE INDEX IF NOT EXISTS "AmazonAdsBrandBuildingMetric_marketplace_computationDate_idx"
  ON "AmazonAdsBrandBuildingMetric" ("marketplace", "computationDate");
