-- BM.B2 — Budget Manager: per-campaign min/max limits on AdBudgetPlan
-- (additive, online-safe — NOT NULL with a default backfills existing rows to '[]').
ALTER TABLE "AdBudgetPlan" ADD COLUMN "campaignLimits" JSONB NOT NULL DEFAULT '[]';
