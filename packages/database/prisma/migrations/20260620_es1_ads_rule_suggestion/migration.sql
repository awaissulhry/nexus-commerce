-- ES1 (Manual Suggestions approval): AdsRuleSuggestion — propose-only rule actions awaiting
-- operator Approve/Dismiss. Additive only: a brand-new table + indexes. No existing table changed.
CREATE TABLE IF NOT EXISTS "AdsRuleSuggestion" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT,
    "executionId" TEXT,
    "trigger" TEXT,
    "marketplace" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "proposedAction" JSONB NOT NULL,
    "proposedKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "appliedResult" JSONB,
    CONSTRAINT "AdsRuleSuggestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdsRuleSuggestion_dedupe_key" ON "AdsRuleSuggestion"("ruleId", "entityId", "proposedKey");
CREATE INDEX IF NOT EXISTS "AdsRuleSuggestion_status_createdAt_idx" ON "AdsRuleSuggestion"("status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AdsRuleSuggestion_ruleId_createdAt_idx" ON "AdsRuleSuggestion"("ruleId", "createdAt" DESC);
