-- UM.1 — Unified Marketing OS core schema (P1).
--
-- Channel-agnostic Campaign abstraction spanning paid ads + promotions/
-- deals + content pushes + review/email outreach, across Amazon, eBay,
-- Shopify, and external networks (Google/Meta/TikTok), over all EU markets.
-- Polymorphism: CORE (MarketingCampaign) + thin per-channel DETAIL tables
-- (1:1) so the cockpit grid filters/sorts typed columns while vendor blobs
-- stay quarantined as JSONB on the detail rows.
--
-- PURE ADDITIVE: all CREATE TYPE / CREATE TABLE — no existing column
-- altered, no data touched. Legacy Campaign / EbayCampaign / RetailEvent /
-- BudgetPool keep running untouched (parallel-run; legacy stays
-- authoritative for Amazon writes until the P8 cutover). Applies online
-- under migrate deploy.
--
-- Rollback: DROP TABLE the 15 new tables + DROP TYPE the 4 new enums.


-- CreateEnum
CREATE TYPE "MktChannel" AS ENUM ('AMAZON', 'EBAY', 'SHOPIFY', 'GOOGLE', 'META', 'TIKTOK', 'INTERNAL');

-- CreateEnum
CREATE TYPE "MktSurface" AS ENUM ('SP', 'SB', 'SD', 'PROMOTED_LISTINGS', 'DISCOUNT', 'MARKDOWN', 'DEAL', 'SHOPPING_FEED', 'CONTENT_PUSH', 'EMAIL_OUTREACH', 'REVIEW_OUTREACH');

-- CreateEnum
CREATE TYPE "MktObjective" AS ENUM ('SALES', 'AWARENESS', 'LIQUIDATION', 'NTB', 'TRAFFIC', 'RETENTION');

-- CreateEnum
CREATE TYPE "MktStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'SUSPENDED', 'FAILED');

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "channel" "MktChannel" NOT NULL,
    "surface" "MktSurface" NOT NULL,
    "objective" "MktObjective" NOT NULL DEFAULT 'SALES',
    "marketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primaryMarketplace" TEXT,
    "budgetScope" TEXT NOT NULL DEFAULT 'SINGLE_MARKET',
    "name" TEXT NOT NULL,
    "status" "MktStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "connectionId" TEXT,
    "budgetCents" INTEGER,
    "budgetKind" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "acos" DECIMAL(8,4),
    "roas" DECIMAL(8,4),
    "deliveryStatus" TEXT,
    "deliveryReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingCampaignLink" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT,
    "externalParentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "deliveryStatus" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaignLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsCampaignDetail" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "profileId" TEXT,
    "portfolioId" TEXT,
    "bidStrategyJson" JSONB,
    "dynamicBidding" JSONB,
    "tactic" TEXT,
    "costType" TEXT,
    "deliveryProfileNative" TEXT,
    "creativeAssetJson" JSONB,
    "brandEntityId" TEXT,

    CONSTRAINT "AmazonAdsCampaignDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayPromotedDetail" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "fundingStrategy" TEXT NOT NULL DEFAULT 'STANDARD',
    "bidPercentage" DECIMAL(5,2),
    "channelConnectionId" TEXT,

    CONSTRAINT "EbayPromotedDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountDetail" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "discountType" TEXT NOT NULL,
    "discountValueCents" INTEGER,
    "discountPercent" DECIMAL(5,2),
    "appliesTo" TEXT NOT NULL DEFAULT 'ALL',
    "appliesToRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "combinesWith" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "usageLimit" INTEGER,
    "priceRuleId" TEXT,
    "discountCodeId" TEXT,

    CONSTRAINT "DiscountDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalAdsDetail" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT,
    "objectiveNative" TEXT,
    "optimizationGoal" TEXT,
    "creativeRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platformConfigJson" JSONB,

    CONSTRAINT "ExternalAdsDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPushDetail" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "aPlusContentId" TEXT,
    "brandStoryId" TEXT,
    "targetRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ContentPushDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachDetail" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "segmentId" TEXT,
    "templateId" TEXT,

    CONSTRAINT "OutreachDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTarget" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expressionType" TEXT,
    "expressionValue" TEXT NOT NULL,
    "isNegative" BOOLEAN NOT NULL DEFAULT false,
    "negativeLevel" TEXT,
    "segmentId" TEXT,
    "bidCents" INTEGER,
    "marketplace" TEXT,
    "externalTargetId" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ENABLED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBudget" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'POOL',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "totalDailyCents" INTEGER NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'STATIC',
    "coolDownMinutes" INTEGER NOT NULL DEFAULT 60,
    "maxShiftPerRebalancePct" INTEGER NOT NULL DEFAULT 20,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "lastRebalancedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "CampaignBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBudgetAllocation" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channel" "MktChannel" NOT NULL,
    "marketplace" TEXT,
    "targetSharePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "minDailyBudgetCents" INTEGER NOT NULL DEFAULT 100,
    "maxDailyBudgetCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignBudgetAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBudgetRebalance" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "outputs" JSONB NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "totalShiftCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignBudgetRebalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignMetric" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "linkId" TEXT,
    "channel" "MktChannel" NOT NULL,
    "marketplace" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "localEntityId" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "costEurCents" BIGINT,
    "sales7dCents" INTEGER DEFAULT 0,
    "sales14dCents" INTEGER DEFAULT 0,
    "sales30dCents" INTEGER DEFAULT 0,
    "orders7d" INTEGER DEFAULT 0,
    "units7d" INTEGER DEFAULT 0,
    "ntbOrders14d" INTEGER,
    "viewableImpressions" INTEGER,
    "detailPageViews7d" INTEGER,
    "extra" JSONB,
    "attributionModel" TEXT,
    "acos7d" DECIMAL(8,4),
    "roas7d" DECIMAL(8,4),
    "reportRunId" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAction" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "executionId" TEXT,
    "userId" TEXT,
    "channel" "MktChannel" NOT NULL,
    "actionType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payloadBefore" JSONB NOT NULL,
    "payloadAfter" JSONB NOT NULL,
    "outboundQueueId" TEXT,
    "channelResponseId" TEXT,
    "channelResponseStatus" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "rollbackReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEntry" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "retailEventId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "channel" "MktChannel",
    "marketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "color" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "CalendarEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingCampaign_channel_status_idx" ON "MarketingCampaign"("channel", "status");

-- CreateIndex
CREATE INDEX "MarketingCampaign_surface_status_idx" ON "MarketingCampaign"("surface", "status");

-- CreateIndex
CREATE INDEX "MarketingCampaign_primaryMarketplace_status_idx" ON "MarketingCampaign"("primaryMarketplace", "status");

-- CreateIndex
CREATE INDEX "MarketingCampaign_startDate_endDate_idx" ON "MarketingCampaign"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "MarketingCampaign_lastSyncStatus_idx" ON "MarketingCampaign"("lastSyncStatus");

-- CreateIndex
CREATE INDEX "MarketingCampaignLink_marketplace_status_idx" ON "MarketingCampaignLink"("marketplace", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignLink_campaignId_marketplace_key" ON "MarketingCampaignLink"("campaignId", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignLink_externalId_marketplace_key" ON "MarketingCampaignLink"("externalId", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsCampaignDetail_campaignId_key" ON "AmazonAdsCampaignDetail"("campaignId");

-- CreateIndex
CREATE INDEX "AmazonAdsCampaignDetail_adProduct_idx" ON "AmazonAdsCampaignDetail"("adProduct");

-- CreateIndex
CREATE INDEX "AmazonAdsCampaignDetail_profileId_idx" ON "AmazonAdsCampaignDetail"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayPromotedDetail_campaignId_key" ON "EbayPromotedDetail"("campaignId");

-- CreateIndex
CREATE INDEX "EbayPromotedDetail_fundingStrategy_idx" ON "EbayPromotedDetail"("fundingStrategy");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountDetail_campaignId_key" ON "DiscountDetail"("campaignId");

-- CreateIndex
CREATE INDEX "DiscountDetail_discountType_idx" ON "DiscountDetail"("discountType");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAdsDetail_campaignId_key" ON "ExternalAdsDetail"("campaignId");

-- CreateIndex
CREATE INDEX "ExternalAdsDetail_platform_idx" ON "ExternalAdsDetail"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPushDetail_campaignId_key" ON "ContentPushDetail"("campaignId");

-- CreateIndex
CREATE INDEX "ContentPushDetail_contentType_idx" ON "ContentPushDetail"("contentType");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDetail_campaignId_key" ON "OutreachDetail"("campaignId");

-- CreateIndex
CREATE INDEX "OutreachDetail_mode_idx" ON "OutreachDetail"("mode");

-- CreateIndex
CREATE INDEX "CampaignTarget_campaignId_kind_idx" ON "CampaignTarget"("campaignId", "kind");

-- CreateIndex
CREATE INDEX "CampaignTarget_campaignId_isNegative_idx" ON "CampaignTarget"("campaignId", "isNegative");

-- CreateIndex
CREATE INDEX "CampaignTarget_externalTargetId_idx" ON "CampaignTarget"("externalTargetId");

-- CreateIndex
CREATE INDEX "CampaignBudget_enabled_lastRebalancedAt_idx" ON "CampaignBudget"("enabled", "lastRebalancedAt");

-- CreateIndex
CREATE INDEX "CampaignBudgetAllocation_budgetId_idx" ON "CampaignBudgetAllocation"("budgetId");

-- CreateIndex
CREATE INDEX "CampaignBudgetAllocation_channel_marketplace_idx" ON "CampaignBudgetAllocation"("channel", "marketplace");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignBudgetAllocation_campaignId_key" ON "CampaignBudgetAllocation"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignBudgetRebalance_budgetId_createdAt_idx" ON "CampaignBudgetRebalance"("budgetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignMetric_campaignId_date_idx" ON "CampaignMetric"("campaignId", "date");

-- CreateIndex
CREATE INDEX "CampaignMetric_marketplace_date_channel_idx" ON "CampaignMetric"("marketplace", "date", "channel");

-- CreateIndex
CREATE INDEX "CampaignMetric_linkId_date_idx" ON "CampaignMetric"("linkId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMetric_channel_entityType_entityId_date_key" ON "CampaignMetric"("channel", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "CampaignAction_executionId_createdAt_idx" ON "CampaignAction"("executionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignAction_entityType_entityId_createdAt_idx" ON "CampaignAction"("entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignAction_campaignId_createdAt_idx" ON "CampaignAction"("campaignId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignAction_createdAt_idx" ON "CampaignAction"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "CalendarEntry_startsAt_endsAt_idx" ON "CalendarEntry"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "CalendarEntry_campaignId_idx" ON "CalendarEntry"("campaignId");

-- CreateIndex
CREATE INDEX "CalendarEntry_retailEventId_idx" ON "CalendarEntry"("retailEventId");

-- AddForeignKey
ALTER TABLE "MarketingCampaignLink" ADD CONSTRAINT "MarketingCampaignLink_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmazonAdsCampaignDetail" ADD CONSTRAINT "AmazonAdsCampaignDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayPromotedDetail" ADD CONSTRAINT "EbayPromotedDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountDetail" ADD CONSTRAINT "DiscountDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAdsDetail" ADD CONSTRAINT "ExternalAdsDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPushDetail" ADD CONSTRAINT "ContentPushDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDetail" ADD CONSTRAINT "OutreachDetail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBudgetAllocation" ADD CONSTRAINT "CampaignBudgetAllocation_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "CampaignBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBudgetAllocation" ADD CONSTRAINT "CampaignBudgetAllocation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBudgetRebalance" ADD CONSTRAINT "CampaignBudgetRebalance_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "CampaignBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMetric" ADD CONSTRAINT "CampaignMetric_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAction" ADD CONSTRAINT "CampaignAction_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

