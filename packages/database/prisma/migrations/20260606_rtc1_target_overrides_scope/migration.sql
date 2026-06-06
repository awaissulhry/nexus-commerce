-- RTC — per-scope rank-target overrides + scoped custom swatches. All additive.
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "scopeProductId" TEXT;
ALTER TABLE "RankTarget" ADD COLUMN IF NOT EXISTS "scopeCampaignId" TEXT;
ALTER TABLE "AdSchedule" ADD COLUMN IF NOT EXISTS "targetOverrides" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "ProductRankPlan" ADD COLUMN IF NOT EXISTS "targetOverrides" JSONB NOT NULL DEFAULT '{}';
