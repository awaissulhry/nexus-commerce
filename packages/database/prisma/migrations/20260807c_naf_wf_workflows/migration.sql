-- NAF.WF.2 — stored workflows: the fleet's named routines as versioned data.
-- Layer 2 of the capability/composition split; session-locks doc §4,
-- REVIEWED by the Workers stream 2026-08-07. Additive only: two new tables
-- and two nullable AgentRun columns. No existing row or object is altered.

-- CreateTable
CREATE TABLE "AgentWorkflow" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'builtin',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWorkflowRevision" (
    "id" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "AgentWorkflowRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflow_key_key" ON "AgentWorkflow"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflowRevision_workflowKey_revision_key" ON "AgentWorkflowRevision"("workflowKey", "revision");

-- CreateIndex
CREATE INDEX "AgentWorkflowRevision_workflowKey_activatedAt_idx" ON "AgentWorkflowRevision"("workflowKey", "activatedAt");

-- AlterTable — the run stamps the workflow + revision that served it.
ALTER TABLE "AgentRun" ADD COLUMN "workflowKey" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "workflowRevisionId" TEXT;
