-- AD.2 — Add dailyBudgetCurrency to Campaign.
-- Non-EUR marketplaces (e.g. UK GBP) have this overridden at sync time
-- from the Amazon Ads API profile. All existing rows get the EUR default.

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "dailyBudgetCurrency" TEXT NOT NULL DEFAULT 'EUR';
