-- ADX A1 — automation bounds on the entity, and keyword protection.
--
-- Purely additive. Every new column is nullable with no default, so every existing
-- row keeps today's behaviour exactly (NULL = unbounded), and the new table starts
-- empty (no protections = nothing is protected, which is the status quo).
--
-- Why columns rather than a rule: a rule saying "never bid above EUR 2" can be
-- edited, bypassed, or simply not exist yet for an entity created tomorrow. These
-- bind every engine automatically because ads-write-gate.ts is the single chokepoint
-- to Amazon and consults them on the way through.

-- 1. Bid bounds + ACOS target on the campaign.
ALTER TABLE "Campaign" ADD COLUMN "minBidCents"   INTEGER;
ALTER TABLE "Campaign" ADD COLUMN "maxBidCents"   INTEGER;
ALTER TABLE "Campaign" ADD COLUMN "targetAcosPct" INTEGER;

-- 2. Keyword protection: WHITELIST = never negate, BLACKLIST = always negate.
CREATE TABLE "AdKeywordProtection" (
    "id"          TEXT NOT NULL,
    "mode"        TEXT NOT NULL,
    "term"        TEXT NOT NULL,
    "isPrefix"    BOOLEAN NOT NULL DEFAULT false,
    "marketplace" TEXT,
    "campaignId"  TEXT,
    "reason"      TEXT,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdKeywordProtection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdKeywordProtection_mode_term_idx"   ON "AdKeywordProtection"("mode", "term");
CREATE INDEX "AdKeywordProtection_marketplace_idx" ON "AdKeywordProtection"("marketplace");
CREATE INDEX "AdKeywordProtection_campaignId_idx"  ON "AdKeywordProtection"("campaignId");
