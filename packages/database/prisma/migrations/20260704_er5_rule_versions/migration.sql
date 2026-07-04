-- ER5 — rule-config versioning: immutable per-version snapshots + the current
-- version pointer on the rule + which version each execution ran under.
-- Reversible:
--   DROP TABLE "EbayAdsRuleVersion";
--   ALTER TABLE "EbayAdsRule" DROP COLUMN "version";
--   ALTER TABLE "EbayAdsRuleExecution" DROP COLUMN "ruleVersion";

ALTER TABLE "EbayAdsRule" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EbayAdsRuleExecution" ADD COLUMN "ruleVersion" INTEGER;

CREATE TABLE "EbayAdsRuleVersion" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" TEXT,
    "scope" JSONB,
    "trigger" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "guardrails" JSONB,
    "cooldownHours" INTEGER NOT NULL,
    "changedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbayAdsRuleVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EbayAdsRuleVersion_ruleId_version_key" ON "EbayAdsRuleVersion"("ruleId", "version");
CREATE INDEX "EbayAdsRuleVersion_ruleId_createdAt_idx" ON "EbayAdsRuleVersion"("ruleId", "createdAt" DESC);

ALTER TABLE "EbayAdsRuleVersion" ADD CONSTRAINT "EbayAdsRuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "EbayAdsRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing rule gets its current config as version 1 so
-- history starts complete (changedBy 'backfill:er5').
INSERT INTO "EbayAdsRuleVersion" ("id", "ruleId", "version", "name", "marketplace", "scope", "trigger", "action", "guardrails", "cooldownHours", "changedBy")
SELECT 'rv_' || md5(random()::text || clock_timestamp()::text), r."id", 1, r."name", r."marketplace", r."scope", r."trigger", r."action", r."guardrails", r."cooldownHours", 'backfill:er5'
FROM "EbayAdsRule" r;
