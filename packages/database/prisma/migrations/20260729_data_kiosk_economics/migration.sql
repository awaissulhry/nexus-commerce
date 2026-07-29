-- Data Kiosk economics ingest. Built against the LIVE contract, probed
-- 2026-07-29 (harnesses: apps/api/scripts/_datakiosk-*.mts).
--
-- Everything below is measured against a real 1,127-row response, not the docs:
--
--  · GRAIN is (date, marketplaceId, childAsin, msku). (date, childAsin) alone
--    COLLIDES 896/1127 — one ASIN carries several MSKUs. Dropping msku from the
--    key would have silently overwritten ~20% of rows, the same class of bug
--    found in the Brand Metrics category grain.
--
--  · netProceeds.perUnit is NULL in 105/1127 rows; netProceeds.total never is.
--
--  · cost.costOfGoodsSold is NULL in 1120/1127 and cost.miscellaneousCost in
--    all 1127 — the operator has not entered COGS in Seller Central. These are
--    ABSENT, not zero, so they stay nullable.
--
--  · `fees` and `ads` come back as arrays with NO identifying field. A row with
--    three fees is three bare amounts (0.32 / 10.53 / 9.48) with nothing saying
--    which is referral vs FBA vs closing. Only the TOTAL is attributable; the
--    labelled breakdown lives on economicsPreview(feeTypes:) and is a separate
--    integration. The whole row is kept in `raw` so nothing is lost meanwhile.
--
-- ADDITIVE — two new tables, nothing existing is touched.

CREATE TABLE IF NOT EXISTS "DataKioskQueryJob" (
  "id"              TEXT PRIMARY KEY,
  "queryType"       TEXT NOT NULL,
  "marketplaceId"   TEXT NOT NULL,
  "startDate"       DATE NOT NULL,
  "endDate"         DATE NOT NULL,
  "externalQueryId" TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'PENDING',
  "dataDocumentId"  TEXT,
  "errorDocumentId" TEXT,
  "query"           TEXT NOT NULL,
  "rowsIngested"    INTEGER NOT NULL DEFAULT 0,
  "errorMessage"    TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "lastPolledAt"    TIMESTAMP(3),
  "completedAt"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "DataKioskQueryJob_status_lastPolledAt_idx"
  ON "DataKioskQueryJob" ("status", "lastPolledAt");
CREATE INDEX IF NOT EXISTS "DataKioskQueryJob_queryType_marketplaceId_startDate_idx"
  ON "DataKioskQueryJob" ("queryType", "marketplaceId", "startDate");
CREATE INDEX IF NOT EXISTS "DataKioskQueryJob_externalQueryId_idx"
  ON "DataKioskQueryJob" ("externalQueryId");

CREATE TABLE IF NOT EXISTS "AmazonEconomicsDaily" (
  "id"                  TEXT PRIMARY KEY,
  "marketplaceId"       TEXT NOT NULL,
  "marketplace"         TEXT NOT NULL,
  "date"                DATE NOT NULL,
  "parentAsin"          TEXT NOT NULL,
  "childAsin"           TEXT NOT NULL,
  "msku"                TEXT NOT NULL,
  "currencyCode"        TEXT NOT NULL DEFAULT 'EUR',
  "unitsOrdered"        INTEGER NOT NULL DEFAULT 0,
  "netProductSales"     DECIMAL(14,2),
  "averageSellingPrice" DECIMAL(14,2),
  "netProceedsTotal"    DECIMAL(14,2),
  "netProceedsPerUnit"  DECIMAL(14,2),
  "feesTotal"           DECIMAL(14,2),
  "feesCount"           INTEGER NOT NULL DEFAULT 0,
  "adsTotal"            DECIMAL(14,2),
  "adsCount"            INTEGER NOT NULL DEFAULT 0,
  "costOfGoodsSold"     DECIMAL(14,2),
  "miscellaneousCost"   DECIMAL(14,2),
  "raw"                 JSONB NOT NULL,
  "reportedAt"          TIMESTAMP(3) NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AmazonEconomicsDaily_mkt_date_childAsin_msku_key"
  ON "AmazonEconomicsDaily" ("marketplaceId", "date", "childAsin", "msku");
CREATE INDEX IF NOT EXISTS "AmazonEconomicsDaily_marketplace_date_idx"
  ON "AmazonEconomicsDaily" ("marketplace", "date");
CREATE INDEX IF NOT EXISTS "AmazonEconomicsDaily_childAsin_date_idx"
  ON "AmazonEconomicsDaily" ("childAsin", "date");
CREATE INDEX IF NOT EXISTS "AmazonEconomicsDaily_msku_date_idx"
  ON "AmazonEconomicsDaily" ("msku", "date");
