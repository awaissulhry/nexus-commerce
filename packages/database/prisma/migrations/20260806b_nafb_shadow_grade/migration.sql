-- NAF.B — shadow grading (docs/2026-08-06-naf-b-analysts.md D3). One
-- additive table; ships empty. Snapshots the deterministic engine's
-- proposal for each analyst finding at grade time.

CREATE TABLE "AgentShadowGrade" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "engineKey" TEXT NOT NULL,
    "engineProposal" JSONB NOT NULL,
    "agrees" BOOLEAN NOT NULL,
    "disagreementReason" TEXT,
    "gradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentShadowGrade_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentShadowGrade_findingId_key" ON "AgentShadowGrade"("findingId");
CREATE INDEX "AgentShadowGrade_engineKey_agrees_idx" ON "AgentShadowGrade"("engineKey", "agrees");
