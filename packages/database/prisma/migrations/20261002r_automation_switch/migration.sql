-- MCP full control R16 (docs/mcp-full-control/sections/06-automation.md §4, decision D-R2) — AutomationSwitch: a
-- per-business switch for an engine that only the server env switched before. Additive only: one new business-owned
-- table; nothing existing is modified. With no rows every engine reads exactly as before (the env alone decides).
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the 20260923a
-- pattern).

-- CreateTable
CREATE TABLE "AutomationSwitch" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "reason" TEXT,
    "setBy" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationSwitch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationSwitch_workspaceId_idx" ON "AutomationSwitch"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationSwitch_workspace_key_key" ON "AutomationSwitch"("workspaceId", "key");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AutomationSwitch" TO nexus_workspace_runtime;
ALTER TABLE "AutomationSwitch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutomationSwitch" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AutomationSwitch";
CREATE POLICY nexus_workspace_isolation ON "AutomationSwitch" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationSwitch"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AutomationSwitch"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AutomationSwitch";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AutomationSwitch" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
