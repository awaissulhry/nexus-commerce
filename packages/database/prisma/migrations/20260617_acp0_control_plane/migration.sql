-- ACP.0 — Agent Control Plane foundation (docs/AGENT_CONTROL_PLANE.md).
-- Five additive tables; all ship empty + dark. No changes to existing
-- tables, so this is non-destructive and safe to deploy ahead of the
-- runtime/UI work that fills them.

CREATE TABLE "AgentDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "surface" TEXT,
    "autonomyTier" TEXT NOT NULL DEFAULT 'suggest',
    "modelFeature" TEXT,
    "systemPrompt" TEXT,
    "toolNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerType" TEXT NOT NULL DEFAULT 'on_demand',
    "triggerConfig" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "agentId" TEXT,
    "agentKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "entityType" TEXT,
    "entityId" TEXT,
    "input" JSONB,
    "output" JSONB,
    "steps" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUSD" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "model" TEXT,
    "provider" TEXT,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentTool" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "riskTier" TEXT NOT NULL DEFAULT 'low',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "rateLimitPerHour" INTEGER,
    "dailyBudgetUSD" DECIMAL(12,6),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTool_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentApproval" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "riskTier" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "preview" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentDefinition_key_key" ON "AgentDefinition"("key");
CREATE INDEX "AgentRun_agentKey_createdAt_idx" ON "AgentRun"("agentKey", "createdAt");
CREATE INDEX "AgentRun_status_createdAt_idx" ON "AgentRun"("status", "createdAt");
CREATE INDEX "AgentRun_entityType_entityId_idx" ON "AgentRun"("entityType", "entityId");
CREATE INDEX "AgentRun_createdAt_idx" ON "AgentRun"("createdAt");
CREATE UNIQUE INDEX "AgentTool_name_key" ON "AgentTool"("name");
CREATE INDEX "AgentApproval_status_requestedAt_idx" ON "AgentApproval"("status", "requestedAt");
CREATE UNIQUE INDEX "AgentMemory_scope_entityType_entityId_key_key" ON "AgentMemory"("scope", "entityType", "entityId", "key");
CREATE INDEX "AgentMemory_scope_entityType_entityId_idx" ON "AgentMemory"("scope", "entityType", "entityId");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
