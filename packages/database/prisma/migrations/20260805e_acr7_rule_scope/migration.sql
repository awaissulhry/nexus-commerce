-- ACR.7 — drag-to-scope: bind an automation rule to one portfolio or one campaign.
-- Additive; null = account-wide, which is exactly today's behaviour, so nothing changes
-- until an operator drags a rule onto something.
ALTER TABLE "AutomationRule" ADD COLUMN "scopePortfolioId" TEXT;
ALTER TABLE "AutomationRule" ADD COLUMN "scopeCampaignId" TEXT;
