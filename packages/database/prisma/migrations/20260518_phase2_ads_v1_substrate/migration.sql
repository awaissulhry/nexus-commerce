-- Phase 2: v1-native Amazon Ads schema substrate.
-- Additive only — no data loss, no breaking changes. Existing Campaign,
-- AdGroup, AdTarget, AdProductAd rows continue to work unchanged.

-- ── Campaign: v1 unified API columns ────────────────────────────────────
ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "adProduct"          TEXT,
  ADD COLUMN IF NOT EXISTS "budgetJson"         JSONB,
  ADD COLUMN IF NOT EXISTS "bidStrategyJson"    JSONB,
  ADD COLUMN IF NOT EXISTS "dynamicBidding"     JSONB,
  ADD COLUMN IF NOT EXISTS "tactic"             TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryProfile"    TEXT,
  ADD COLUMN IF NOT EXISTS "costType"           TEXT,
  ADD COLUMN IF NOT EXISTS "creativeAssetJson"  JSONB,
  ADD COLUMN IF NOT EXISTS "brandEntityId"      TEXT,
  ADD COLUMN IF NOT EXISTS "budgetScope"        TEXT NOT NULL DEFAULT 'SINGLE_MARKETPLACE',
  ADD COLUMN IF NOT EXISTS "linkedMarketplaces" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS "Campaign_adProduct_marketplace_status_idx"
  ON "Campaign" ("adProduct", "marketplace", "status");

-- ── AdGroup: v1 additions ───────────────────────────────────────────────
ALTER TABLE "AdGroup"
  ADD COLUMN IF NOT EXISTS "bidStrategyJson" JSONB,
  ADD COLUMN IF NOT EXISTS "creativeType"    TEXT;

-- ── AdTarget: positive/negative distinction ─────────────────────────────
ALTER TABLE "AdTarget"
  ADD COLUMN IF NOT EXISTS "isNegative"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "negativeLevel" TEXT;

CREATE INDEX IF NOT EXISTS "AdTarget_adGroupId_isNegative_idx"
  ON "AdTarget" ("adGroupId", "isNegative");

-- ── AmazonAdsProfile: first-class profile metadata ──────────────────────
CREATE TABLE IF NOT EXISTS "AmazonAdsProfile" (
  "id"                  TEXT PRIMARY KEY,
  "profileId"           TEXT NOT NULL UNIQUE,
  "marketplace"         TEXT NOT NULL,
  "region"              TEXT NOT NULL DEFAULT 'EU',
  "countryCode"         TEXT,
  "currencyCode"        TEXT NOT NULL DEFAULT 'EUR',
  "timezone"            TEXT,
  "accountType"         TEXT NOT NULL DEFAULT 'seller',
  "accountEntityId"     TEXT,
  "accountName"         TEXT,
  "validPaymentMethod"  BOOLEAN NOT NULL DEFAULT true,
  "lastSyncedAt"        TIMESTAMP(3),
  "lastProfileFetchAt"  TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "AmazonAdsProfile_countryCode_idx"
  ON "AmazonAdsProfile" ("countryCode");
CREATE INDEX IF NOT EXISTS "AmazonAdsProfile_currencyCode_idx"
  ON "AmazonAdsProfile" ("currencyCode");
CREATE INDEX IF NOT EXISTS "AmazonAdsProfile_marketplace_idx"
  ON "AmazonAdsProfile" ("marketplace");

-- ── AmazonAdsPortfolio: Amazon-native portfolio grouping ────────────────
CREATE TABLE IF NOT EXISTS "AmazonAdsPortfolio" (
  "id"                  TEXT PRIMARY KEY,
  "profileId"           TEXT NOT NULL,
  "externalPortfolioId" TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "state"               TEXT,
  "budgetAmount"        DECIMAL(12, 2),
  "budgetCurrencyCode"  TEXT,
  "budgetPolicy"        TEXT,
  "startDate"           TIMESTAMP(3),
  "endDate"             TIMESTAMP(3),
  "inBudget"            BOOLEAN NOT NULL DEFAULT true,
  "lastSyncedAt"        TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmazonAdsPortfolio_profileId_externalPortfolioId_key"
    UNIQUE ("profileId", "externalPortfolioId")
);

CREATE INDEX IF NOT EXISTS "AmazonAdsPortfolio_profileId_state_idx"
  ON "AmazonAdsPortfolio" ("profileId", "state");

-- ── AmazonAdsDailyPerformance: universal time-series ────────────────────
-- One row per (profile, adProduct, entityType, entityId, date). BigInt
-- micros for cross-currency precision.
CREATE TABLE IF NOT EXISTS "AmazonAdsDailyPerformance" (
  "id"                  TEXT PRIMARY KEY,
  "profileId"           TEXT NOT NULL,
  "marketplace"         TEXT NOT NULL,
  "adProduct"           TEXT NOT NULL,
  "date"                DATE NOT NULL,
  "entityType"          TEXT NOT NULL,
  "entityId"            TEXT NOT NULL,
  "localEntityId"       TEXT,
  "impressions"         INTEGER NOT NULL DEFAULT 0,
  "clicks"              INTEGER NOT NULL DEFAULT 0,
  "costMicros"          BIGINT NOT NULL DEFAULT 0,
  "currencyCode"        TEXT NOT NULL,
  "sales1dCents"        INTEGER DEFAULT 0,
  "sales7dCents"        INTEGER DEFAULT 0,
  "sales14dCents"       INTEGER DEFAULT 0,
  "sales30dCents"       INTEGER DEFAULT 0,
  "orders7d"            INTEGER DEFAULT 0,
  "units7d"             INTEGER DEFAULT 0,
  "ntbOrders14d"        INTEGER DEFAULT 0,
  "ntbSalesCents14d"    INTEGER DEFAULT 0,
  "viewableImpressions" INTEGER DEFAULT 0,
  "detailPageViews7d"   INTEGER DEFAULT 0,
  "acos7d"              DECIMAL(8, 4),
  "roas7d"              DECIMAL(8, 4),
  "reportRunId"         TEXT,
  "reportedAt"          TIMESTAMP(3) NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmazonAdsDailyPerformance_unique"
    UNIQUE ("profileId", "adProduct", "entityType", "entityId", "date")
);

CREATE INDEX IF NOT EXISTS "AmazonAdsDailyPerformance_profileId_adProduct_date_idx"
  ON "AmazonAdsDailyPerformance" ("profileId", "adProduct", "date");
CREATE INDEX IF NOT EXISTS "AmazonAdsDailyPerformance_localEntityId_date_idx"
  ON "AmazonAdsDailyPerformance" ("localEntityId", "date");
CREATE INDEX IF NOT EXISTS "AmazonAdsDailyPerformance_marketplace_date_adProduct_idx"
  ON "AmazonAdsDailyPerformance" ("marketplace", "date", "adProduct");

-- ── AmazonAdsSearchTerm: 90-day rolling search-term storage ─────────────
CREATE TABLE IF NOT EXISTS "AmazonAdsSearchTerm" (
  "id"               TEXT PRIMARY KEY,
  "profileId"        TEXT NOT NULL,
  "marketplace"      TEXT NOT NULL,
  "adProduct"        TEXT NOT NULL,
  "date"             DATE NOT NULL,
  "campaignId"       TEXT NOT NULL,
  "adGroupId"        TEXT NOT NULL,
  "matchedKeywordId" TEXT,
  "matchedTargetId"  TEXT,
  "matchType"        TEXT,
  "query"            TEXT NOT NULL,
  "impressions"      INTEGER NOT NULL DEFAULT 0,
  "clicks"           INTEGER NOT NULL DEFAULT 0,
  "costMicros"       BIGINT NOT NULL DEFAULT 0,
  "currencyCode"     TEXT NOT NULL,
  "sales7dCents"     INTEGER DEFAULT 0,
  "orders7d"         INTEGER DEFAULT 0,
  "reportRunId"      TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AmazonAdsSearchTerm_profileId_date_idx"
  ON "AmazonAdsSearchTerm" ("profileId", "date");
CREATE INDEX IF NOT EXISTS "AmazonAdsSearchTerm_campaignId_date_idx"
  ON "AmazonAdsSearchTerm" ("campaignId", "date");
CREATE INDEX IF NOT EXISTS "AmazonAdsSearchTerm_profileId_query_idx"
  ON "AmazonAdsSearchTerm" ("profileId", "query");

-- ── AmazonAdsPlacementReport: placement-level performance ───────────────
CREATE TABLE IF NOT EXISTS "AmazonAdsPlacementReport" (
  "id"              TEXT PRIMARY KEY,
  "profileId"       TEXT NOT NULL,
  "marketplace"     TEXT NOT NULL,
  "adProduct"       TEXT NOT NULL,
  "date"            DATE NOT NULL,
  "campaignId"     TEXT NOT NULL,
  "localCampaignId" TEXT,
  "placement"       TEXT NOT NULL,
  "impressions"     INTEGER NOT NULL DEFAULT 0,
  "clicks"          INTEGER NOT NULL DEFAULT 0,
  "costMicros"      BIGINT NOT NULL DEFAULT 0,
  "currencyCode"    TEXT NOT NULL,
  "sales7dCents"    INTEGER DEFAULT 0,
  "orders7d"        INTEGER DEFAULT 0,
  "reportRunId"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmazonAdsPlacementReport_unique"
    UNIQUE ("campaignId", "date", "placement")
);

CREATE INDEX IF NOT EXISTS "AmazonAdsPlacementReport_profileId_adProduct_date_idx"
  ON "AmazonAdsPlacementReport" ("profileId", "adProduct", "date");

-- ── AmazonAdsBrandMetric: Brand Metrics API output ──────────────────────
CREATE TABLE IF NOT EXISTS "AmazonAdsBrandMetric" (
  "id"                    TEXT PRIMARY KEY,
  "profileId"             TEXT NOT NULL,
  "marketplace"           TEXT NOT NULL,
  "brandName"             TEXT NOT NULL,
  "date"                  DATE NOT NULL,
  "searchImpressionShare" DECIMAL(8, 4),
  "brandSearches"         BIGINT,
  "brandConversionShare"  DECIMAL(8, 4),
  "categoryRank"          INTEGER,
  "reportedAt"            TIMESTAMP(3) NOT NULL,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmazonAdsBrandMetric_unique"
    UNIQUE ("profileId", "brandName", "date")
);

-- ── AmazonAdsReportJob: persistent async report polling state ───────────
CREATE TABLE IF NOT EXISTS "AmazonAdsReportJob" (
  "id"               TEXT PRIMARY KEY,
  "profileId"        TEXT NOT NULL,
  "adProduct"        TEXT NOT NULL,
  "reportTypeId"     TEXT NOT NULL,
  "externalReportId" TEXT NOT NULL,
  "startDate"        TIMESTAMP(3) NOT NULL,
  "endDate"          TIMESTAMP(3) NOT NULL,
  "configuration"    JSONB NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "location"         TEXT,
  "fileSize"         INTEGER,
  "rowsIngested"     INTEGER NOT NULL DEFAULT 0,
  "errorMessage"     TEXT,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "lastPolledAt"     TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  "completedAt"      TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "AmazonAdsReportJob_status_lastPolledAt_idx"
  ON "AmazonAdsReportJob" ("status", "lastPolledAt");
CREATE INDEX IF NOT EXISTS "AmazonAdsReportJob_profileId_adProduct_createdAt_idx"
  ON "AmazonAdsReportJob" ("profileId", "adProduct", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AmazonAdsReportJob_externalReportId_idx"
  ON "AmazonAdsReportJob" ("externalReportId");
