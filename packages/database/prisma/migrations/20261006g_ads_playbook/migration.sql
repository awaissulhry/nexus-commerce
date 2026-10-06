-- ADS PLAYBOOK PB-1 — one home for HOW a product's Amazon ads are built and run: AdsPlaybookTemplate (a reusable
-- campaign set, flows, rank roles and phases), AdsPlaybook (one row per market, category or product in one market,
-- scoped like AdsStrategy), AdsPlaybookVersion (every change of either, append-only) and AdsPlaybookLink (what a
-- product's playbook owns: slot campaigns, compiled rules, hourly-plan groups, its portfolio). Plus one nullable column,
-- AdBlueprintApplication.playbookId (a build run belongs to its playbook).
--
-- Additive only: four new business-owned tables and one nullable column; nothing existing is modified. No code reads or
-- writes the tables in this release, and no engine ever reads them (a playbook is compiled by an approved apply), so
-- every screen, engine and Claude call behaves exactly as before.
--
-- Order: (1) the tables, column and indexes Prisma derives from schema.prisma; (2) row-level security for the four
-- tables, emitted by workspaceModelSql() in scripts/workspace-policies.mjs so it carries the same bytes the disposable
-- test database gets (the 20260923a pattern). None has a foreign key (scope ids are polymorphic; history and links
-- outlive a removed row), so the reference guard has nothing to check.

-- AlterTable
ALTER TABLE "AdBlueprintApplication" ADD COLUMN IF NOT EXISTS "playbookId" TEXT;

-- CreateTable
CREATE TABLE "AdsPlaybookTemplate" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'AMAZON',
    "adProduct" TEXT NOT NULL DEFAULT 'SP',
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "doc" JSONB NOT NULL,
    "capturedFrom" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "AdsPlaybookTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsPlaybook" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'AMAZON',
    "market" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '*',
    "label" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "templateId" TEXT,
    "overrides" JSONB,
    "enrolled" BOOLEAN,
    "state" TEXT,
    "nameToken" TEXT,
    "portfolioName" TEXT,
    "dailyBudgetCents" INTEGER,
    "baseBidCents" INTEGER,
    "terms" JSONB,
    "phaseRecipes" JSONB,
    "compiledVersion" INTEGER,
    "compiledTemplateVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "AdsPlaybook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsPlaybookVersion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "market" TEXT,
    "level" TEXT,
    "scopeId" TEXT,
    "op" TEXT NOT NULL,
    "values" JSONB,
    "changes" JSONB NOT NULL,
    "via" TEXT NOT NULL,
    "approvalId" TEXT,
    "actor" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsPlaybookVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsPlaybookLink" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "playbookId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "origin" TEXT NOT NULL,
    "compiledVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "AdsPlaybookLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsPlaybookTemplate_workspaceId_idx" ON "AdsPlaybookTemplate"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsPlaybookTemplate_workspace_name_key" ON "AdsPlaybookTemplate"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AdsPlaybook_market_level_idx" ON "AdsPlaybook"("market", "level");

-- CreateIndex
CREATE INDEX "AdsPlaybook_templateId_idx" ON "AdsPlaybook"("templateId");

-- CreateIndex
CREATE INDEX "AdsPlaybook_workspaceId_idx" ON "AdsPlaybook"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsPlaybook_channel_market_level_scopeId_key" ON "AdsPlaybook"("workspaceId", "channel", "market", "level", "scopeId");

-- CreateIndex
CREATE INDEX "AdsPlaybookVersion_kind_market_level_scopeId_createdAt_idx" ON "AdsPlaybookVersion"("kind", "market", "level", "scopeId", "createdAt");

-- CreateIndex
CREATE INDEX "AdsPlaybookVersion_workspaceId_idx" ON "AdsPlaybookVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsPlaybookVersion_kind_refId_version_key" ON "AdsPlaybookVersion"("workspaceId", "kind", "refId", "version");

-- CreateIndex
CREATE INDEX "AdsPlaybookLink_workspaceId_idx" ON "AdsPlaybookLink"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsPlaybookLink_kind_refId_key" ON "AdsPlaybookLink"("workspaceId", "kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsPlaybookLink_playbookId_kind_key_key" ON "AdsPlaybookLink"("workspaceId", "playbookId", "kind", "key");

-- CreateIndex
CREATE INDEX "AdBlueprintApplication_playbookId_idx" ON "AdBlueprintApplication"("playbookId");



-- ── (2) Row-level security for the business-owned tables ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsPlaybookTemplate" TO nexus_workspace_runtime;
ALTER TABLE "AdsPlaybookTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsPlaybookTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsPlaybookTemplate";
CREATE POLICY nexus_workspace_isolation ON "AdsPlaybookTemplate" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsPlaybookTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsPlaybookTemplate"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsPlaybookTemplate";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsPlaybookTemplate" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsPlaybook" TO nexus_workspace_runtime;
ALTER TABLE "AdsPlaybook" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsPlaybook" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsPlaybook";
CREATE POLICY nexus_workspace_isolation ON "AdsPlaybook" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsPlaybook"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsPlaybook"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsPlaybook";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsPlaybook" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsPlaybookVersion" TO nexus_workspace_runtime;
ALTER TABLE "AdsPlaybookVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsPlaybookVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsPlaybookVersion";
CREATE POLICY nexus_workspace_isolation ON "AdsPlaybookVersion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsPlaybookVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsPlaybookVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsPlaybookVersion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsPlaybookVersion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsPlaybookLink" TO nexus_workspace_runtime;
ALTER TABLE "AdsPlaybookLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsPlaybookLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsPlaybookLink";
CREATE POLICY nexus_workspace_isolation ON "AdsPlaybookLink" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsPlaybookLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsPlaybookLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsPlaybookLink";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsPlaybookLink" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
