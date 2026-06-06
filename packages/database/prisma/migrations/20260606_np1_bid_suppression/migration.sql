-- NP — no-pause bid suppression: remember the pre-suppression bid so it can be
-- restored exactly, plus a fast per-campaign "is suppressed" flag. All additive.
ALTER TABLE "AdTarget" ADD COLUMN IF NOT EXISTS "suppressedFromBidCents" INTEGER;
ALTER TABLE "AdGroup" ADD COLUMN IF NOT EXISTS "suppressedFromBidCents" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "bidsSuppressedAt" TIMESTAMP(3);
