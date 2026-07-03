-- AlterTable
ALTER TABLE "EbayCampaign" ADD COLUMN     "adRateStrategy" TEXT,
ADD COLUMN     "budgetUpdatesDay" TIMESTAMP(3),
ADD COLUMN     "budgetUpdatesToday" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "campaignCriterion" JSONB,
ADD COLUMN     "campaignTargetingType" TEXT,
ADD COLUMN     "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "dynamicAdRatePrefs" JSONB,
ADD COLUMN     "fundingModel" TEXT,
ADD COLUMN     "isRulesBased" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastEntitySyncAt" TIMESTAMP(3),
ADD COLUMN     "nexusManaged" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EbayAdGroup" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "externalAdGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "defaultBidCents" INTEGER,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAd" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "marketplace" TEXT NOT NULL,
    "listingId" TEXT,
    "inventoryReference" TEXT,
    "inventoryReferenceType" TEXT,
    "externalAdId" TEXT,
    "bidPercentage" DECIMAL(6,2),
    "status" TEXT NOT NULL,
    "createdVia" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "hiddenReason" TEXT,
    "productId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayKeyword" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "externalKeywordId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "bidCents" INTEGER,
    "status" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayNegativeKeyword" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "externalId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayNegativeKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsReportTask" (
    "id" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "fundingModel" TEXT NOT NULL,
    "marketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "campaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dateFrom" DATE NOT NULL,
    "dateTo" DATE NOT NULL,
    "dimensions" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "externalTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reportHref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3),
    "downloadedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "rowsIngested" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdsReportTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsDailyPerformance" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "fundingModel" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "ctr" DECIMAL(8,5),
    "avgCostPerClickCents" INTEGER,
    "adFeesCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "soldQty" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "extra" JSONB,
    "reportTaskId" TEXT,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdsDailyPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayListingIndex" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "title" TEXT,
    "categoryId" TEXT,
    "price" DECIMAL(10,2),
    "currency" TEXT,
    "quantity" INTEGER,
    "quantitySold" INTEGER,
    "format" TEXT,
    "variationSkus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aspects" JSONB,
    "source" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "relistedFromItemId" TEXT,
    "detailSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayListingIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayListingEconomics" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "productId" TEXT,
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "cogsCents" INTEGER,
    "ebayFeesCents" INTEGER,
    "feesSource" TEXT,
    "shippingCostCents" INTEGER,
    "contributionMarginCents" INTEGER,
    "contributionMarginPct" DECIMAL(6,2),
    "breakEvenAdRatePct" DECIMAL(6,2),
    "breakEvenCpcCents" INTEGER,
    "dataStatus" TEXT NOT NULL DEFAULT 'MISSING_COGS',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbayListingEconomics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAutomationState" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "globalMode" TEXT NOT NULL DEFAULT 'OFF',
    "halted" BOOLEAN NOT NULL DEFAULT false,
    "haltReason" TEXT,
    "haltedBy" TEXT,
    "maxHourlySpendCentsEur" INTEGER,
    "maxActionsPerHour" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingAutomationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingSpendCeiling" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "monthlyCapCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingSpendCeiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'PROPOSE',
    "marketplace" TEXT,
    "scope" JSONB,
    "trigger" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "guardrails" JSONB,
    "cooldownHours" INTEGER NOT NULL DEFAULT 24,
    "lastEvaluatedAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdsRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsRuleExecution" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evaluated" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "proposed" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbayAdsRuleExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsProposal" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT,
    "kind" TEXT NOT NULL,
    "entityRef" JSONB NOT NULL,
    "proposedAction" JSONB NOT NULL,
    "reasoning" JSONB,
    "proposedKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "estimatedImpact" JSONB,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedResult" JSONB,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayAdsProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayAdsDigest" (
    "id" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "EbayAdsDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EbayAdGroup_campaignId_status_idx" ON "EbayAdGroup"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdGroup_campaignId_externalAdGroupId_key" ON "EbayAdGroup"("campaignId", "externalAdGroupId");

-- CreateIndex
CREATE INDEX "EbayAd_listingId_idx" ON "EbayAd"("listingId");

-- CreateIndex
CREATE INDEX "EbayAd_productId_idx" ON "EbayAd"("productId");

-- CreateIndex
CREATE INDEX "EbayAd_marketplace_status_idx" ON "EbayAd"("marketplace", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAd_campaignId_listingId_key" ON "EbayAd"("campaignId", "listingId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAd_campaignId_inventoryReference_key" ON "EbayAd"("campaignId", "inventoryReference");

-- CreateIndex
CREATE INDEX "EbayKeyword_campaignId_status_idx" ON "EbayKeyword"("campaignId", "status");

-- CreateIndex
CREATE INDEX "EbayKeyword_text_idx" ON "EbayKeyword"("text");

-- CreateIndex
CREATE UNIQUE INDEX "EbayKeyword_adGroupId_externalKeywordId_key" ON "EbayKeyword"("adGroupId", "externalKeywordId");

-- CreateIndex
CREATE INDEX "EbayNegativeKeyword_campaignId_status_idx" ON "EbayNegativeKeyword"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EbayNegativeKeyword_campaignId_externalId_key" ON "EbayNegativeKeyword"("campaignId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsReportTask_externalTaskId_key" ON "EbayAdsReportTask"("externalTaskId");

-- CreateIndex
CREATE INDEX "EbayAdsReportTask_status_lastPolledAt_idx" ON "EbayAdsReportTask"("status", "lastPolledAt");

-- CreateIndex
CREATE INDEX "EbayAdsReportTask_reportType_fundingModel_dateFrom_dateTo_idx" ON "EbayAdsReportTask"("reportType", "fundingModel", "dateFrom", "dateTo");

-- CreateIndex
CREATE INDEX "EbayAdsDailyPerformance_entityType_entityId_date_idx" ON "EbayAdsDailyPerformance"("entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "EbayAdsDailyPerformance_date_idx" ON "EbayAdsDailyPerformance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsDailyPerformance_marketplace_fundingModel_entityType_key" ON "EbayAdsDailyPerformance"("marketplace", "fundingModel", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "EbayListingIndex_matchStatus_idx" ON "EbayListingIndex"("matchStatus");

-- CreateIndex
CREATE INDEX "EbayListingIndex_endedAt_idx" ON "EbayListingIndex"("endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EbayListingIndex_marketplace_itemId_key" ON "EbayListingIndex"("marketplace", "itemId");

-- CreateIndex
CREATE INDEX "EbayListingEconomics_productId_idx" ON "EbayListingEconomics"("productId");

-- CreateIndex
CREATE INDEX "EbayListingEconomics_dataStatus_idx" ON "EbayListingEconomics"("dataStatus");

-- CreateIndex
CREATE UNIQUE INDEX "EbayListingEconomics_marketplace_itemId_key" ON "EbayListingEconomics"("marketplace", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAutomationState_channel_key" ON "MarketingAutomationState"("channel");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSpendCeiling_channel_marketplace_key" ON "MarketingSpendCeiling"("channel", "marketplace");

-- CreateIndex
CREATE INDEX "EbayAdsRule_enabled_mode_idx" ON "EbayAdsRule"("enabled", "mode");

-- CreateIndex
CREATE INDEX "EbayAdsRuleExecution_ruleId_createdAt_idx" ON "EbayAdsRuleExecution"("ruleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsProposal_proposedKey_key" ON "EbayAdsProposal"("proposedKey");

-- CreateIndex
CREATE INDEX "EbayAdsProposal_status_createdAt_idx" ON "EbayAdsProposal"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EbayAdsDigest_weekStart_key" ON "EbayAdsDigest"("weekStart");

-- AddForeignKey
ALTER TABLE "EbayAdGroup" ADD CONSTRAINT "EbayAdGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayAd" ADD CONSTRAINT "EbayAd_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayAd" ADD CONSTRAINT "EbayAd_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "EbayAdGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayKeyword" ADD CONSTRAINT "EbayKeyword_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayKeyword" ADD CONSTRAINT "EbayKeyword_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "EbayAdGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayNegativeKeyword" ADD CONSTRAINT "EbayNegativeKeyword_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EbayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayAdsRuleExecution" ADD CONSTRAINT "EbayAdsRuleExecution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "EbayAdsRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- E2 backfill: modern funding vocabulary from the legacy column
-- (STANDARD -> COST_PER_SALE, ADVANCED -> COST_PER_CLICK). Table currently
-- empty in prod (0 rows) - kept for correctness on any restored data.
UPDATE "EbayCampaign"
SET "fundingModel" = CASE WHEN "fundingStrategy" = 'ADVANCED'
                          THEN 'COST_PER_CLICK' ELSE 'COST_PER_SALE' END
WHERE "fundingModel" IS NULL;
