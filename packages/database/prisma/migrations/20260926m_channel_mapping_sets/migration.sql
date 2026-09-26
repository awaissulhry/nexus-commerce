-- CHMAP M1 (docs/studies/channel-mappings.md §8.5) — channel mappings as versioned data.
-- Additive only: three new business-owned tables; nothing existing is modified. With no rows, every import,
-- export and push behaves exactly as before.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) the guards Prisma cannot express: allowed
-- values and at most ONE active version per form; (3) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs (the same bytes the disposable test database gets).

-- CreateTable
CREATE TABLE "ChannelMappingSet" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "formKind" TEXT NOT NULL,
    "formKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "templateIdentifier" TEXT,
    "templateVersion" TEXT,
    "language" TEXT,
    "layout" JSONB,
    "keyFingerprint" TEXT NOT NULL,
    "basedOnId" TEXT,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedBy" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelMappingSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMappingField" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "columnKey" TEXT,
    "label" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requirement" TEXT,
    "templateRequirement" TEXT,
    "targetKind" TEXT NOT NULL,
    "targetKey" TEXT,
    "transform" JSONB NOT NULL DEFAULT '[]',
    "direction" TEXT NOT NULL DEFAULT 'both',
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "decidedBy" TEXT NOT NULL DEFAULT 'rule',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ChannelMappingField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMappingUse" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reference" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMappingUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelMappingSet_workspaceId_idx" ON "ChannelMappingSet"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelMappingSet_channel_marketplace_formKind_formKey_stat_idx" ON "ChannelMappingSet"("channel", "marketplace", "formKind", "formKey", "status");

-- CreateIndex
CREATE INDEX "ChannelMappingSet_templateIdentifier_idx" ON "ChannelMappingSet"("templateIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMappingSet_workspaceId_channel_marketplace_formKind__key" ON "ChannelMappingSet"("workspaceId", "channel", "marketplace", "formKind", "formKey", "version");

-- CreateIndex
CREATE INDEX "ChannelMappingField_setId_idx" ON "ChannelMappingField"("setId");

-- CreateIndex
CREATE INDEX "ChannelMappingField_workspaceId_idx" ON "ChannelMappingField"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMappingField_workspaceId_setId_channelKey_key" ON "ChannelMappingField"("workspaceId", "setId", "channelKey");

-- CreateIndex
CREATE INDEX "ChannelMappingUse_setId_createdAt_idx" ON "ChannelMappingUse"("setId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelMappingUse_workspaceId_idx" ON "ChannelMappingUse"("workspaceId");

-- AddForeignKey
ALTER TABLE "ChannelMappingField" ADD CONSTRAINT "ChannelMappingField_setId_fkey" FOREIGN KEY ("setId") REFERENCES "ChannelMappingSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMappingUse" ADD CONSTRAINT "ChannelMappingUse_setId_fkey" FOREIGN KEY ("setId") REFERENCES "ChannelMappingSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── (2) Guards ──────────────────────────────────────────────────────────────────
ALTER TABLE "ChannelMappingSet" ADD CONSTRAINT "ChannelMappingSet_status_check" CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED'));
ALTER TABLE "ChannelMappingSet" ADD CONSTRAINT "ChannelMappingSet_version_check" CHECK (version >= 1);
ALTER TABLE "ChannelMappingField" ADD CONSTRAINT "ChannelMappingField_state_check" CHECK (state IN ('mapped', 'ignored', 'managed', 'unmapped'));
ALTER TABLE "ChannelMappingField" ADD CONSTRAINT "ChannelMappingField_direction_check" CHECK (direction IN ('in', 'out', 'both'));
CREATE UNIQUE INDEX "ChannelMappingSet_one_active_per_form" ON "ChannelMappingSet" ("workspaceId", channel, marketplace, "formKind", "formKey") WHERE status = 'ACTIVE';


-- ── (3) Row-level security for the business-owned tables ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelMappingSet" TO nexus_workspace_runtime;
ALTER TABLE "ChannelMappingSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelMappingSet" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelMappingSet";
CREATE POLICY nexus_workspace_isolation ON "ChannelMappingSet" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelMappingSet"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelMappingSet"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelMappingSet";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelMappingSet" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelMappingField" TO nexus_workspace_runtime;
ALTER TABLE "ChannelMappingField" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelMappingField" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelMappingField";
CREATE POLICY nexus_workspace_isolation ON "ChannelMappingField" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelMappingField"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelMappingField"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelMappingField";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelMappingField" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelMappingSet","from":"setId","to":"id"}]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelMappingUse" TO nexus_workspace_runtime;
ALTER TABLE "ChannelMappingUse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelMappingUse" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelMappingUse";
CREATE POLICY nexus_workspace_isolation ON "ChannelMappingUse" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelMappingUse"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelMappingUse"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelMappingUse";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelMappingUse" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelMappingSet","from":"setId","to":"id"}]');
