-- Platform health watchdog (2026-10-07) — PlatformHealthCheck: one row per daily check of the platform (crons, data
-- feeds, ad writes, approvals, automation, queues), with its verdict in plain words and the numbers it rests on.
-- Additive only: one new business-owned table; nothing existing is modified, and with no rows every current screen and
-- job behaves exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "PlatformHealthCheck" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "subsystem" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "likelyCause" TEXT,
    "nextStep" TEXT,
    "evidence" JSONB NOT NULL,
    "triggeredBy" TEXT NOT NULL DEFAULT 'cron',
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformHealthCheck_checkId_measuredAt_idx" ON "PlatformHealthCheck"("checkId", "measuredAt" DESC);

-- CreateIndex
CREATE INDEX "PlatformHealthCheck_runId_idx" ON "PlatformHealthCheck"("runId");

-- CreateIndex
CREATE INDEX "PlatformHealthCheck_measuredAt_idx" ON "PlatformHealthCheck"("measuredAt");

-- CreateIndex
CREATE INDEX "PlatformHealthCheck_workspaceId_idx" ON "PlatformHealthCheck"("workspaceId");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PlatformHealthCheck" TO nexus_workspace_runtime;
ALTER TABLE "PlatformHealthCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformHealthCheck" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "PlatformHealthCheck";
CREATE POLICY nexus_workspace_isolation ON "PlatformHealthCheck" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PlatformHealthCheck"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "PlatformHealthCheck"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "PlatformHealthCheck";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "PlatformHealthCheck" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
