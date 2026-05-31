-- Apex E.1 — Brand Analytics Search Query Performance (competitive share intel).
-- Additive: new table only. Market totals vs our brand counts per query (+ ASIN),
-- with funnel shares (impressions/clicks/cart-adds/purchases).
CREATE TABLE IF NOT EXISTS "SearchQueryPerformance" (
  "id"                TEXT NOT NULL,
  "marketplace"       TEXT NOT NULL,
  "reportPeriod"      TEXT NOT NULL,
  "startDate"         DATE NOT NULL,
  "searchQuery"       TEXT NOT NULL,
  "asin"              TEXT,
  "searchQueryVolume" INTEGER NOT NULL DEFAULT 0,
  "searchQueryRank"   INTEGER,
  "impressionsTotal"  INTEGER NOT NULL DEFAULT 0,
  "impressionsBrand"  INTEGER NOT NULL DEFAULT 0,
  "impressionShare"   DECIMAL(6,4) NOT NULL DEFAULT 0,
  "clicksTotal"       INTEGER NOT NULL DEFAULT 0,
  "clicksBrand"       INTEGER NOT NULL DEFAULT 0,
  "clickShare"        DECIMAL(6,4) NOT NULL DEFAULT 0,
  "cartAddsTotal"     INTEGER NOT NULL DEFAULT 0,
  "cartAddsBrand"     INTEGER NOT NULL DEFAULT 0,
  "cartAddShare"      DECIMAL(6,4) NOT NULL DEFAULT 0,
  "purchasesTotal"    INTEGER NOT NULL DEFAULT 0,
  "purchasesBrand"    INTEGER NOT NULL DEFAULT 0,
  "purchaseShare"     DECIMAL(6,4) NOT NULL DEFAULT 0,
  "sourceReportId"    TEXT,
  "ingestedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SearchQueryPerformance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SearchQueryPerformance_mkt_period_date_query_asin_key"
  ON "SearchQueryPerformance" ("marketplace","reportPeriod","startDate","searchQuery","asin");
CREATE INDEX IF NOT EXISTS "SearchQueryPerformance_marketplace_startDate_idx" ON "SearchQueryPerformance" ("marketplace","startDate");
CREATE INDEX IF NOT EXISTS "SearchQueryPerformance_searchQuery_idx" ON "SearchQueryPerformance" ("searchQuery");
CREATE INDEX IF NOT EXISTS "SearchQueryPerformance_asin_startDate_idx" ON "SearchQueryPerformance" ("asin","startDate");
