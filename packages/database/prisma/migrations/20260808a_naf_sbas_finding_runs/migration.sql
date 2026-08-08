-- NAF.SB.AS.5 — which runs detected which finding. Additive; AgentFinding is
-- untouched, so nothing that reads it today changes behaviour.
CREATE TABLE "AgentFindingRun" (
    "findingId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentFindingRun_pkey" PRIMARY KEY ("findingId","runId")
);

CREATE INDEX "AgentFindingRun_runId_idx" ON "AgentFindingRun"("runId");
