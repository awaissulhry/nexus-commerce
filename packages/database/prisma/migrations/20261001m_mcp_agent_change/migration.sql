-- MCP full control C2 (docs/mcp-full-control/sections/05-control-layer.md §3.4, §4) — AgentChange: what an approved
-- change did, so a person or Claude can see it and undo it. Additive only: one new business-owned table; nothing
-- existing is modified, and with no rows every current screen and job behaves exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the 20260923a
-- pattern).

-- CreateTable
CREATE TABLE "AgentChange" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "planStepId" TEXT,
    "toolName" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "oauthGrantId" TEXT,
    "executedByUserId" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversibility" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "undoTool" TEXT,
    "undoArgs" JSONB,
    "undoneAt" TIMESTAMP(3),
    "undoneByApprovalId" TEXT,
    "outbound" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AgentChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentChange_workspaceId_executedAt_idx" ON "AgentChange"("workspaceId", "executedAt");

-- CreateIndex
CREATE INDEX "AgentChange_approvalId_idx" ON "AgentChange"("approvalId");

-- CreateIndex
CREATE INDEX "AgentChange_undoneByApprovalId_idx" ON "AgentChange"("undoneByApprovalId");

-- AddForeignKey
ALTER TABLE "AgentChange" ADD CONSTRAINT "AgentChange_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "AgentApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentChange" TO nexus_workspace_runtime;
ALTER TABLE "AgentChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentChange" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentChange";
CREATE POLICY nexus_workspace_isolation ON "AgentChange" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentChange"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentChange"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentChange";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentChange" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"AgentApproval","from":"approvalId","to":"id"}]');
