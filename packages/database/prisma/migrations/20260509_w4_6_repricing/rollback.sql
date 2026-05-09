-- Rollback for W4.6 — drop RepricingDecision + RepricingRule.
DROP TABLE IF EXISTS "RepricingDecision" CASCADE;
DROP TABLE IF EXISTS "RepricingRule" CASCADE;
