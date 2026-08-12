-- KT.6 — a per-scope spend ceiling, and the proposal ledger that makes "committed today" answerable.
-- Purely additive: two new tables, nothing altered, nothing dropped.

CREATE TABLE "AdSpendCeiling" (
    "id" TEXT NOT NULL,
    "grain" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    -- NULLABLE on purpose: null = no ceiling set, NOT unlimited.
    "dailyCapCents" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSpendCeiling_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdSpendCeiling_grain_scopeId_key" ON "AdSpendCeiling"("grain", "scopeId");
CREATE INDEX "AdSpendCeiling_enabled_idx" ON "AdSpendCeiling"("enabled");

CREATE TABLE "KeywordBidProposal" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "requestedBidCents" INTEGER NOT NULL,
    "matchedTargets" INTEGER NOT NULL,
    "matchedCampaigns" INTEGER NOT NULL,
    "actionableTargets" INTEGER NOT NULL,
    "actionableCampaigns" INTEGER NOT NULL,
    "excludedByReason" JSONB NOT NULL,
    "targetIds" JSONB NOT NULL,
    "commitmentCents" INTEGER NOT NULL,
    "ceilingVerdict" TEXT NOT NULL,
    "ceilingGrain" TEXT,
    "ceilingScopeId" TEXT,
    "ceilingCapCents" INTEGER,
    "ceilingMessage" TEXT NOT NULL,
    "committedCents" INTEGER NOT NULL DEFAULT 0,
    "shareAgeDays" INTEGER,
    "confirmationText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "proposedBy" TEXT,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "executionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordBidProposal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KeywordBidProposal_marketplace_status_proposedAt_idx" ON "KeywordBidProposal"("marketplace", "status", "proposedAt");
CREATE INDEX "KeywordBidProposal_status_proposedAt_idx" ON "KeywordBidProposal"("status", "proposedAt");
CREATE INDEX "KeywordBidProposal_term_marketplace_idx" ON "KeywordBidProposal"("term", "marketplace");
