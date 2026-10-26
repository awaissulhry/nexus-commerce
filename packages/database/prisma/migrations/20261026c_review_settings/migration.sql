-- Reviews settings (2026-10-26, Reviews area rebuild PR D) — the business's reply voice and review alerts, and the
-- saved reply templates the Inbox reply box offers.
--
--   ReviewSettings        ONE row per business (unique workspaceId): tone (WARM | NEUTRAL | FORMAL), reply languages,
--                         sign-off, words to avoid, and the review alerts (JSON: key, on, recipients, via). No row = the
--                         defaults in services/reviews/review-settings.service.ts, which match today's behaviour.
--   ReviewReplyTemplate   a saved reply: name (unique per business), channel (null = every channel), one text per
--                         language (JSON { locale: text }), and how often a person picked it.
--
-- Additive only: two new business-owned tables; nothing existing is changed or dropped. With no rows, every current
-- screen and job behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma (prisma migrate diff, schema to schema, offline); (2) row-level
-- security for each new table, emitted by workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern),
-- after its runtime-role grant.
--
-- Rollback: DROP TABLE "ReviewReplyTemplate"; DROP TABLE "ReviewSettings";

-- CreateTable
CREATE TABLE "ReviewSettings" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "tone" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signOff" TEXT,
    "avoidWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alerts" JSONB NOT NULL DEFAULT '[]',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewReplyTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT,
    "bodies" JSONB NOT NULL DEFAULT '{}',
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewReplyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSettings_workspaceId_key" ON "ReviewSettings"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewReplyTemplate_workspaceId_idx" ON "ReviewReplyTemplate"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewReplyTemplate_workspace_name_key" ON "ReviewReplyTemplate"("workspaceId", "name");

-- ── (2) Row-level security for ReviewSettings ────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewSettings" TO nexus_workspace_runtime;
ALTER TABLE "ReviewSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewSettings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewSettings";
CREATE POLICY nexus_workspace_isolation ON "ReviewSettings" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSettings"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewSettings"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewSettings";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewSettings" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for ReviewReplyTemplate ───────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewReplyTemplate" TO nexus_workspace_runtime;
ALTER TABLE "ReviewReplyTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewReplyTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewReplyTemplate";
CREATE POLICY nexus_workspace_isolation ON "ReviewReplyTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewReplyTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewReplyTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewReplyTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewReplyTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
