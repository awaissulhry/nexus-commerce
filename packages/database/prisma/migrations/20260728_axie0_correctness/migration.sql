-- AX-IE.0 — additive only. No drops, no rewrites, no defaults applied to existing rows
-- beyond the estimate backfill below (which is explicitly flagged as an estimate).

-- E4: Amazon's real campaign targeting type, replacing a regex over the campaign name.
-- Null until ads-campaign-settings-sync observes it from v3; the exporter emits blank
-- rather than guessing.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "targetingType" TEXT;

-- Refresh-token lifetime tracking. From 2026-07-30 Amazon refresh tokens expire
-- 365 days from consent and nothing tracked token age.
ALTER TABLE "AmazonAdsConnection" ADD COLUMN IF NOT EXISTS "tokenIssuedAt" TIMESTAMP(3);
ALTER TABLE "AmazonAdsConnection" ADD COLUMN IF NOT EXISTS "tokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "AmazonAdsConnection" ADD COLUMN IF NOT EXISTS "tokenIssuedAtIsEstimate" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "AmazonAdsConnection_tokenExpiresAt_idx"
  ON "AmazonAdsConnection"("tokenExpiresAt");

-- Backfill: the existing connections were seeded in a single batch, so their true
-- consent dates are unrecoverable. Use createdAt as a CONSERVATIVE floor (it cannot
-- be later than consent) and flag every one as an estimate so the countdown UI shows
-- it as approximate. Cleared the first time a real consent or rotation stamps it.
UPDATE "AmazonAdsConnection"
   SET "tokenIssuedAt"           = "createdAt",
       "tokenExpiresAt"          = "createdAt" + INTERVAL '365 days',
       "tokenIssuedAtIsEstimate" = true
 WHERE "tokenIssuedAt" IS NULL;
