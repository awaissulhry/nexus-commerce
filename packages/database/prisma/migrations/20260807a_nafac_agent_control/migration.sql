-- NAF.AC — Agent Control: charter revisions, evals, control audit, and the
-- per-worker policy columns. Additive only; no existing object is altered
-- beyond new nullable columns with safe defaults.

-- AlterTable
ALTER TABLE "AgentCharter"
  ADD COLUMN "modelProviderOverride" TEXT,
  ADD COLUMN "modelNameOverride" TEXT,
  ADD COLUMN "pausedUntil" TIMESTAMP(3),
  ADD COLUMN "pausedReason" TEXT,
  ADD COLUMN "abEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "candidateRevisionId" TEXT;

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "charterRevisionId" TEXT;

-- CreateTable
CREATE TABLE "AgentCharterRevision" (
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "policy" JSONB,
    "note" TEXT NOT NULL,
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "AgentCharterRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvalRun" (
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "revisionId" TEXT,
    "baseline" JSONB NOT NULL,
    "candidate" JSONB NOT NULL,
    "verdict" TEXT NOT NULL,
    "measures" JSONB NOT NULL,
    "cases" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentControlAudit" (
    "id" TEXT NOT NULL,
    "charterKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromValue" JSONB,
    "toValue" JSONB,
    "note" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentControlAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentCharterRevision_charterKey_revision_key" ON "AgentCharterRevision"("charterKey", "revision");

-- CreateIndex
CREATE INDEX "AgentCharterRevision_charterKey_activatedAt_idx" ON "AgentCharterRevision"("charterKey", "activatedAt");

-- CreateIndex
CREATE INDEX "AgentEvalRun_charterKey_createdAt_idx" ON "AgentEvalRun"("charterKey", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEvalRun_revisionId_idx" ON "AgentEvalRun"("revisionId");

-- CreateIndex
CREATE INDEX "AgentControlAudit_charterKey_createdAt_idx" ON "AgentControlAudit"("charterKey", "createdAt");
