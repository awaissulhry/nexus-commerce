-- MCP full control C5 (docs/mcp-full-control/sections/05-control-layer.md §3.2, §4) — trust levels and limits for
-- Claude, per business and per tool, and Claude's brakes per business. Additive only: two nullable or defaulted
-- columns on AgentTool, one nullable column on AgentApproval, one new business-owned table. With no rows and the
-- defaults, every tool stays at `ask` and every current screen, job and Claude call behaves exactly as before.
--
-- Order: (1) the columns and the table Prisma derives from schema.prisma; (2) row-level security for the new table,
-- emitted by workspaceModelSql() in scripts/workspace-policies.mjs so it carries the same bytes the disposable test
-- database gets (the 20260923a pattern).

-- AlterTable
ALTER TABLE "AgentTool" ADD COLUMN "claudeTrust" TEXT NOT NULL DEFAULT 'ask',
ADD COLUMN "claudeLimits" JSONB;

-- AlterTable
ALTER TABLE "AgentApproval" ADD COLUMN "decisionVia" TEXT;

-- CreateTable
CREATE TABLE "AgentAutonomy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "autoPausedAt" TIMESTAMP(3),
    "autoPausedBy" TEXT,
    "pauseReason" TEXT,
    "dailyAutoCap" INTEGER NOT NULL DEFAULT 200,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAutonomy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentAutonomy_workspaceId_key" ON "AgentAutonomy"("workspaceId");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentAutonomy" TO nexus_workspace_runtime;
ALTER TABLE "AgentAutonomy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentAutonomy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AgentAutonomy";
CREATE POLICY nexus_workspace_isolation ON "AgentAutonomy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentAutonomy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AgentAutonomy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AgentAutonomy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AgentAutonomy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
