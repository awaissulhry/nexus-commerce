-- ADM-P6 — Amazon's own per-campaign budget-usage reading, sampled.
-- Additive: one new table, no column touched, nothing dropped.
CREATE TABLE "AdBudgetUsageSample" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "externalCampaignId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "percent" DOUBLE PRECISION NOT NULL,
    "budgetCents" INTEGER NOT NULL,
    "usageUpdatedAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'pull',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdBudgetUsageSample_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdBudgetUsageSample_reading_key" ON "AdBudgetUsageSample"("campaignId", "source", "usageUpdatedAt");
CREATE INDEX "AdBudgetUsageSample_campaign_reading_idx" ON "AdBudgetUsageSample"("campaignId", "usageUpdatedAt");
CREATE INDEX "AdBudgetUsageSample_lastSeenAt_idx" ON "AdBudgetUsageSample"("lastSeenAt");
