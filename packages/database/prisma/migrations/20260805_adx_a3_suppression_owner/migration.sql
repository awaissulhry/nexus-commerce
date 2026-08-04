-- ADX A3 — record WHICH engine bid-suppressed a campaign.
--
-- Additive and nullable on purpose: existing suppressed rows keep NULL, and every engine
-- reads NULL as "not mine", so this can never cause an engine to restore a suppression it
-- did not create.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "bidsSuppressedBy" TEXT;
