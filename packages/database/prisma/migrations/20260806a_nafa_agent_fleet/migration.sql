-- NAF.A — Nexus Agent Fleet foundation (docs/AGENT_FLEET.md).
-- Nine additive tables + six additive AgentRun columns; everything ships
-- empty and dark (AgentCharter.enabled defaults false, no cron registered).
-- Non-destructive: no existing column is altered or dropped.

CREATE TABLE "AgentCharter" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tier" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "outputSchemaKey" TEXT NOT NULL,
    "toolNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "observationKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modelFeature" TEXT NOT NULL,
    "fallbackFeature" TEXT,
    "autonomyLevel" TEXT NOT NULL DEFAULT 'OFF',
    "autonomyCap" TEXT NOT NULL DEFAULT 'PROPOSE',
    "cadence" TEXT,
    "scopeMarketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopePortfolioIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopeCampaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxFindingsPerRun" INTEGER NOT NULL DEFAULT 20,
    "maxToolCallsPerRun" INTEGER NOT NULL DEFAULT 12,
    "maxTokensPerRun" INTEGER NOT NULL DEFAULT 60000,
    "dailyBudgetUSD" DECIMAL(12,6) NOT NULL DEFAULT 1.00,
    "maxProposedValueCents" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "supersededBy" TEXT,

    CONSTRAINT "AgentCharter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentObservation" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "marketplace" TEXT,
    "payload" JSONB NOT NULL,
    "dataVintage" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,

    CONSTRAINT "AgentObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "charterVersion" INTEGER NOT NULL,
    "domain" TEXT NOT NULL,
    "marketplace" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "observation" JSONB NOT NULL,
    "evidenceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dataVintage" TIMESTAMP(3) NOT NULL,
    "proposedTool" TEXT,
    "proposedArgs" JSONB,
    "expectedEffect" JSONB,
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dedupeKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "planId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentFinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentPlan" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "marketplace" TEXT,
    "strategyId" TEXT,
    "horizon" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "droppedItems" JSONB NOT NULL,
    "conflicts" JSONB NOT NULL,
    "changeBudget" JSONB NOT NULL,
    "blastRadius" JSONB NOT NULL,
    "criticVerdict" TEXT,
    "criticNotes" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AgentPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentStrategy" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "northStar" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "objectives" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "allocations" JSONB NOT NULL,
    "watchlist" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStrategy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentStep" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spanId" TEXT,
    "parentSpanId" TEXT,
    "input" JSONB,
    "output" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentExemplar" (
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "situation" JSONB NOT NULL,
    "proposal" JSONB NOT NULL,
    "operatorNote" TEXT,
    "correctedArgs" JSONB,
    "weight" DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExemplar_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentScorecard" (
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "findings" INTEGER NOT NULL DEFAULT 0,
    "promoted" INTEGER NOT NULL DEFAULT 0,
    "approved" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "executed" INTEGER NOT NULL DEFAULT 0,
    "rolledBack" INTEGER NOT NULL DEFAULT 0,
    "acceptanceRate" DECIMAL(5,4),
    "calibrationError" DECIMAL(6,4),
    "realisedImpactCents" INTEGER,
    "shadowAgreement" DECIMAL(5,4),
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "costPerAcceptedAction" DECIMAL(12,6),
    "grade" TEXT,
    "promotionEligible" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AgentScorecard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentFleetState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "halted" BOOLEAN NOT NULL DEFAULT false,
    "haltedAt" TIMESTAMP(3),
    "haltReason" TEXT,
    "haltedBy" TEXT,
    "dailyCeilingUSD" DECIMAL(12,6) NOT NULL DEFAULT 2.00,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFleetState_pkey" PRIMARY KEY ("id")
);

-- AgentRun — additive fleet columns (agentKey doubles as the charter key).
ALTER TABLE "AgentRun" ADD COLUMN "charterVersion" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "mode" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "parentRunId" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "orchestrationId" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "findingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRun" ADD COLUMN "haltedReason" TEXT;

CREATE UNIQUE INDEX "AgentCharter_key_version_key" ON "AgentCharter"("key", "version");
CREATE INDEX "AgentCharter_tier_domain_enabled_idx" ON "AgentCharter"("tier", "domain", "enabled");
CREATE UNIQUE INDEX "AgentObservation_key_entityType_entityId_marketplace_key" ON "AgentObservation"("key", "entityType", "entityId", "marketplace");
CREATE INDEX "AgentObservation_expiresAt_idx" ON "AgentObservation"("expiresAt");
CREATE UNIQUE INDEX "AgentFinding_dedupe" ON "AgentFinding"("charterKey", "entityType", "entityId", "dedupeKey");
CREATE INDEX "AgentFinding_domain_status_createdAt_idx" ON "AgentFinding"("domain", "status", "createdAt");
CREATE INDEX "AgentFinding_entityType_entityId_idx" ON "AgentFinding"("entityType", "entityId");
CREATE INDEX "AgentFinding_planId_idx" ON "AgentFinding"("planId");
CREATE INDEX "AgentPlan_domain_status_createdAt_idx" ON "AgentPlan"("domain", "status", "createdAt");
CREATE INDEX "AgentStrategy_status_periodStart_idx" ON "AgentStrategy"("status", "periodStart");
CREATE UNIQUE INDEX "AgentStep_agentRunId_seq_key" ON "AgentStep"("agentRunId", "seq");
CREATE INDEX "AgentStep_agentRunId_idx" ON "AgentStep"("agentRunId");
CREATE INDEX "AgentExemplar_charterKey_label_active_idx" ON "AgentExemplar"("charterKey", "label", "active");
CREATE UNIQUE INDEX "AgentScorecard_charterKey_periodStart_periodEnd_key" ON "AgentScorecard"("charterKey", "periodStart", "periodEnd");
CREATE INDEX "AgentScorecard_charterKey_periodEnd_idx" ON "AgentScorecard"("charterKey", "periodEnd");
CREATE INDEX "AgentRun_orchestrationId_idx" ON "AgentRun"("orchestrationId");
