-- AD.1 — Trading Desk substrate (Pillar 2 of the elite marketing blueprint).
-- See /Users/awais/.claude/plans/here-is-the-blueprint-humming-beaver.md.
--
-- Adds: Campaign extensions + 6 new advertising/profit/storage models +
-- 2 enums + DRAFT value on CampaignStatus. All additive — existing
-- Campaign rows (currently empty, the table was a Phase-1 stub) keep
-- working with NULL marketplace.

-- ── Enum changes ──────────────────────────────────────────────────────
-- CampaignStatus gains DRAFT in the sibling migration
-- 20260516_ad1_campaign_status_draft_enum (split because ALTER TYPE
-- ADD VALUE can't run inside a transaction block).

-- New enums for advertising entities.
DO $$ BEGIN
  CREATE TYPE "BiddingStrategy" AS ENUM ('LEGACY_FOR_SALES', 'AUTO_FOR_SALES', 'MANUAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AdSyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── Campaign extensions ───────────────────────────────────────────────

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "marketplace" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "externalCampaignId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "portfolioId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "biddingStrategy" "BiddingStrategy" NOT NULL DEFAULT 'LEGACY_FOR_SALES';
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "acos" DECIMAL(8, 4);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "roas" DECIMAL(8, 4);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "trueProfitCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "trueProfitMarginPct" DECIMAL(8, 4);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "lastSyncStatus" "AdSyncStatus";
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "lastSyncError" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_externalCampaignId_marketplace_key"
  ON "Campaign" ("externalCampaignId", "marketplace");
CREATE INDEX IF NOT EXISTS "Campaign_marketplace_status_idx"
  ON "Campaign" ("marketplace", "status");
CREATE INDEX IF NOT EXISTS "Campaign_lastSyncStatus_idx"
  ON "Campaign" ("lastSyncStatus");

-- ── AdGroup ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AdGroup" (
  "id" TEXT PRIMARY KEY,
  "campaignId" TEXT NOT NULL REFERENCES "Campaign"("id") ON DELETE CASCADE,
  "externalAdGroupId" TEXT,
  "name" TEXT NOT NULL,
  "defaultBidCents" INTEGER NOT NULL DEFAULT 50,
  "status" "CampaignStatus" NOT NULL DEFAULT 'ENABLED',
  "targetingType" TEXT NOT NULL DEFAULT 'MANUAL',
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "spendCents" INTEGER NOT NULL DEFAULT 0,
  "salesCents" INTEGER NOT NULL DEFAULT 0,
  "lastSyncedAt" TIMESTAMP(3),
  "lastSyncStatus" "AdSyncStatus",
  "lastSyncError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdGroup_externalAdGroupId_campaignId_key"
  ON "AdGroup" ("externalAdGroupId", "campaignId");
CREATE INDEX IF NOT EXISTS "AdGroup_campaignId_status_idx"
  ON "AdGroup" ("campaignId", "status");

-- ── AdTarget ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AdTarget" (
  "id" TEXT PRIMARY KEY,
  "adGroupId" TEXT NOT NULL REFERENCES "AdGroup"("id") ON DELETE CASCADE,
  "externalTargetId" TEXT,
  "kind" TEXT NOT NULL,
  "expressionType" TEXT NOT NULL,
  "expressionValue" TEXT NOT NULL,
  "bidCents" INTEGER NOT NULL DEFAULT 50,
  "status" "CampaignStatus" NOT NULL DEFAULT 'ENABLED',
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "spendCents" INTEGER NOT NULL DEFAULT 0,
  "salesCents" INTEGER NOT NULL DEFAULT 0,
  "ordersCount" INTEGER NOT NULL DEFAULT 0,
  "lastSyncedAt" TIMESTAMP(3),
  "lastSyncStatus" "AdSyncStatus",
  "lastSyncError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "AdTarget_adGroupId_status_idx"
  ON "AdTarget" ("adGroupId", "status");
CREATE INDEX IF NOT EXISTS "AdTarget_externalTargetId_idx"
  ON "AdTarget" ("externalTargetId");

-- ── AdProductAd ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AdProductAd" (
  "id" TEXT PRIMARY KEY,
  "adGroupId" TEXT NOT NULL REFERENCES "AdGroup"("id") ON DELETE CASCADE,
  "productId" TEXT REFERENCES "Product"("id") ON DELETE SET NULL,
  "asin" TEXT,
  "sku" TEXT,
  "externalAdId" TEXT,
  "status" "CampaignStatus" NOT NULL DEFAULT 'ENABLED',
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "spendCents" INTEGER NOT NULL DEFAULT 0,
  "salesCents" INTEGER NOT NULL DEFAULT 0,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdProductAd_adGroupId_asin_key"
  ON "AdProductAd" ("adGroupId", "asin");
CREATE INDEX IF NOT EXISTS "AdProductAd_productId_idx" ON "AdProductAd" ("productId");
CREATE INDEX IF NOT EXISTS "AdProductAd_asin_idx" ON "AdProductAd" ("asin");

-- ── AmazonAdsConnection ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AmazonAdsConnection" (
  "id" TEXT PRIMARY KEY,
  "profileId" TEXT NOT NULL UNIQUE,
  "marketplace" TEXT NOT NULL,
  "region" TEXT NOT NULL DEFAULT 'EU',
  "accountLabel" TEXT,
  "credentialsEncrypted" TEXT,
  "mode" TEXT NOT NULL DEFAULT 'sandbox',
  "writesEnabledAt" TIMESTAMP(3),
  "lastWriteAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "lastVerifiedAt" TIMESTAMP(3),
  "lastErrorAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "AmazonAdsConnection_marketplace_isActive_idx"
  ON "AmazonAdsConnection" ("marketplace", "isActive");

-- ── FbaStorageAge ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "FbaStorageAge" (
  "id" TEXT PRIMARY KEY,
  "productId" TEXT REFERENCES "Product"("id") ON DELETE SET NULL,
  "sku" TEXT NOT NULL,
  "asin" TEXT,
  "marketplace" TEXT NOT NULL,
  "polledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "quantityInAge0_90" INTEGER NOT NULL DEFAULT 0,
  "quantityInAge91_180" INTEGER NOT NULL DEFAULT 0,
  "quantityInAge181_270" INTEGER NOT NULL DEFAULT 0,
  "quantityInAge271_365" INTEGER NOT NULL DEFAULT 0,
  "quantityInAge365Plus" INTEGER NOT NULL DEFAULT 0,

  "projectedLtsFee30dCents" INTEGER NOT NULL DEFAULT 0,
  "projectedLtsFee60dCents" INTEGER NOT NULL DEFAULT 0,
  "projectedLtsFee90dCents" INTEGER NOT NULL DEFAULT 0,
  "currentStorageFeeCents" INTEGER NOT NULL DEFAULT 0,

  "daysToLtsThreshold" INTEGER,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "FbaStorageAge_sku_marketplace_polledAt_key"
  ON "FbaStorageAge" ("sku", "marketplace", "polledAt");
CREATE INDEX IF NOT EXISTS "FbaStorageAge_productId_marketplace_idx"
  ON "FbaStorageAge" ("productId", "marketplace");
CREATE INDEX IF NOT EXISTS "FbaStorageAge_marketplace_daysToLtsThreshold_idx"
  ON "FbaStorageAge" ("marketplace", "daysToLtsThreshold");

-- ── ProductProfitDaily ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ProductProfitDaily" (
  "id" TEXT PRIMARY KEY,
  "productId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
  "marketplace" TEXT NOT NULL,
  "date" DATE NOT NULL,

  "unitsSold" INTEGER NOT NULL DEFAULT 0,
  "grossRevenueCents" INTEGER NOT NULL DEFAULT 0,
  "cogsCents" INTEGER NOT NULL DEFAULT 0,
  "referralFeesCents" INTEGER NOT NULL DEFAULT 0,
  "fbaFulfillmentFeesCents" INTEGER NOT NULL DEFAULT 0,
  "fbaStorageFeesCents" INTEGER NOT NULL DEFAULT 0,
  "advertisingSpendCents" INTEGER NOT NULL DEFAULT 0,
  "returnsRefundsCents" INTEGER NOT NULL DEFAULT 0,
  "otherFeesCents" INTEGER NOT NULL DEFAULT 0,

  "trueProfitCents" INTEGER NOT NULL DEFAULT 0,
  "trueProfitMarginPct" DECIMAL(8, 4),

  "coverage" JSONB,

  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductProfitDaily_productId_marketplace_date_key"
  ON "ProductProfitDaily" ("productId", "marketplace", "date");
CREATE INDEX IF NOT EXISTS "ProductProfitDaily_marketplace_date_idx"
  ON "ProductProfitDaily" ("marketplace", "date");
CREATE INDEX IF NOT EXISTS "ProductProfitDaily_trueProfitMarginPct_idx"
  ON "ProductProfitDaily" ("trueProfitMarginPct");

-- ── CampaignBidHistory ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CampaignBidHistory" (
  "id" TEXT PRIMARY KEY,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "campaignId" TEXT REFERENCES "Campaign"("id") ON DELETE CASCADE,
  "field" TEXT NOT NULL,
  "oldValue" TEXT,
  "newValue" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changedBy" TEXT NOT NULL,
  "reason" TEXT
);

CREATE INDEX IF NOT EXISTS "CampaignBidHistory_entityType_entityId_changedAt_idx"
  ON "CampaignBidHistory" ("entityType", "entityId", "changedAt" DESC);
CREATE INDEX IF NOT EXISTS "CampaignBidHistory_campaignId_idx"
  ON "CampaignBidHistory" ("campaignId");
