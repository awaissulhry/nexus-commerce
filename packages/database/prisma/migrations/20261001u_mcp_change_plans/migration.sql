-- MCP full control C6 (docs/mcp-full-control/sections/05-control-layer.md §3.1, §4) — change plans: one approval for up
-- to 200 changes. Additive only: two nullable columns on AgentApproval and one new business-owned table. Nothing
-- existing is modified; with no plan, every current screen, job and Claude call behaves exactly as before.
--
-- Order: (1) the columns and the table Prisma derives from schema.prisma; (2) row-level security for the new table,
-- emitted by workspaceModelSql() in scripts/workspace-policies.mjs (the 20260923a pattern).

-- AlterTable
ALTER TABLE "AgentApproval" ADD COLUMN "summary" TEXT,
ADD COLUMN "planHash" TEXT;

-- CreateTable
CREATE TABLE "AgentPlanStep" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "preview" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "changeId" TEXT,
    "undoesChangeId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPlanStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentPlanStep_approvalId_status_idx" ON "AgentPlanStep"("approvalId", "status");
-- CreateIndex
CREATE INDEX "AgentPlanStep_workspaceId_idx" ON "AgentPlanStep"("workspaceId");
-- CreateIndex
CREATE UNIQUE INDEX "AgentPlanStep_approvalId_position_key" ON "AgentPlanStep"("approvalId", "position");

-- AddForeignKey
ALTER TABLE "AgentPlanStep" ADD CONSTRAINT "AgentPlanStep_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "AgentApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentPlanStep" TO nexus_workspace_runtime;
ALTER TABLE "AgentPlanStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentPlanStep" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentPlanStep";
CREATE POLICY nexus_workspace_isolation ON "AgentPlanStep" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentPlanStep"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentPlanStep"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentPlanStep";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentPlanStep" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AgentApproval","from":"approvalId","to":"id"}]');
