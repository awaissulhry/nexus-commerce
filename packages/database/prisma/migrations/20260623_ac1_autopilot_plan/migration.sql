-- AC — AI Control / Autopilot: AutopilotPlan + AutopilotDecision
-- CreateTable
CREATE TABLE "AutopilotPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "productGroupName" TEXT,
    "campaignIds" JSONB NOT NULL DEFAULT '[]',
    "goal" TEXT NOT NULL DEFAULT 'BALANCED',
    "autonomy" TEXT NOT NULL DEFAULT 'SUGGEST',
    "guardrails" JSONB NOT NULL DEFAULT '{}',
    "modules" JSONB NOT NULL DEFAULT '{}',
    "graph" JSONB NOT NULL DEFAULT '{}',
    "linkedRuleIds" JSONB NOT NULL DEFAULT '[]',
    "stage" TEXT NOT NULL DEFAULT 'launch',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastDecisionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AutopilotPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutopilotDecision" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycle" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "campaignId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "executionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'autopilot',

    CONSTRAINT "AutopilotDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutopilotPlan_enabled_idx" ON "AutopilotPlan"("enabled");
CREATE INDEX "AutopilotPlan_marketplace_idx" ON "AutopilotPlan"("marketplace");
CREATE INDEX "AutopilotDecision_planId_at_idx" ON "AutopilotDecision"("planId", "at");
CREATE INDEX "AutopilotDecision_status_idx" ON "AutopilotDecision"("status");

-- AddForeignKey
ALTER TABLE "AutopilotDecision" ADD CONSTRAINT "AutopilotDecision_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AutopilotPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
