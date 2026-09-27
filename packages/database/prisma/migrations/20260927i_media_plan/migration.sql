-- Images rebuild P1 (docs/images-studio-rebuild/PLAN.md §6.1) — the media plan and photo language versions.
-- Additive only: one new business-owned table and two new ProductImage columns (one with a default, one nullable).
-- Nothing existing is modified or read differently; with no ProductMediaPlan rows every current screen, job and
-- publisher behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN     "languageTag" TEXT NOT NULL DEFAULT 'zxx',
ADD COLUMN     "versionGroupId" TEXT;

-- CreateTable
CREATE TABLE "ProductMediaPlan" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT '',
    "marketplace" TEXT NOT NULL DEFAULT '',
    "channelConnectionId" TEXT NOT NULL DEFAULT '',
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "plan" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMediaPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductMediaPlan_workspaceId_idx" ON "ProductMediaPlan"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductMediaPlan_productId_idx" ON "ProductMediaPlan"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMediaPlan_workspaceId_productId_layer_channel_market_key" ON "ProductMediaPlan"("workspaceId", "productId", "layer", "channel", "marketplace", "channelConnectionId", "aliasKey");

-- CreateIndex
CREATE INDEX "ProductImage_versionGroupId_idx" ON "ProductImage"("versionGroupId");

-- AddForeignKey
ALTER TABLE "ProductMediaPlan" ADD CONSTRAINT "ProductMediaPlan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ProductMediaPlan" TO nexus_workspace_runtime;
ALTER TABLE "ProductMediaPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductMediaPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ProductMediaPlan";
CREATE POLICY nexus_workspace_isolation ON "ProductMediaPlan" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductMediaPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ProductMediaPlan"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ProductMediaPlan";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ProductMediaPlan" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"productId","to":"id"}]');
