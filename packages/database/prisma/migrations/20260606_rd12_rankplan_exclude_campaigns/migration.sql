-- RD.12 — manual campaign scope for ProductRankPlan.
-- Additive, nullable-with-default: existing plans keep controlling the whole family.
ALTER TABLE "ProductRankPlan" ADD COLUMN IF NOT EXISTS "excludeCampaignIds" JSONB NOT NULL DEFAULT '[]';
