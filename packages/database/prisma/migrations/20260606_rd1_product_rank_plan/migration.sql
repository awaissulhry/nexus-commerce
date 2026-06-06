-- RD.1 — Rank Director: ONE family-level rank+dayparting plan that fans out to
-- every Amazon campaign advertising a product family's ASINs in a market. Fully
-- additive (one new table; nothing here changes existing schedule/cron behaviour).
-- Family membership is resolved LIVE at evaluation time (resolveProductFamily) —
-- never stored, since AdProductAd.productId is often null and campaigns join/leave.

CREATE TABLE "ProductRankPlan" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "parentAsin" TEXT,
    "marketplace" TEXT NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "defaultTargetKey" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "familyDailyBudgetCents" INTEGER,
    "familyAcosCapPct" INTEGER,
    "maxCampaigns" INTEGER,
    "leadTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "manualOnly" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "ProductRankPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductRankPlan_productId_marketplace_key" ON "ProductRankPlan"("productId", "marketplace");
CREATE INDEX "ProductRankPlan_enabled_idx" ON "ProductRankPlan"("enabled");
CREATE INDEX "ProductRankPlan_marketplace_enabled_idx" ON "ProductRankPlan"("marketplace", "enabled");
