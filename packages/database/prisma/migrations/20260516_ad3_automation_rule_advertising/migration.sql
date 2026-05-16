-- AD.3 — AutomationRule extensions for the advertising domain.
--
-- maxDailyAdSpendCentsEur: per-rule SUM cap across all of today's
-- executions. Complements maxValueCentsEur (per-execution).
-- scopeMarketplace: confine triggers to one marketplace without
-- needing conditions DSL boilerplate.
--
-- Both are additive + nullable so every existing replenishment rule
-- keeps working unchanged.

ALTER TABLE "AutomationRule" ADD COLUMN IF NOT EXISTS "maxDailyAdSpendCentsEur" INTEGER;
ALTER TABLE "AutomationRule" ADD COLUMN IF NOT EXISTS "scopeMarketplace" TEXT;
