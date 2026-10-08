-- ONE BRAIN AB-16 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §2.9, §2.6 N2, §4 step 3, §5, §8 row AB-16, §10
-- D1 = B and D2 = A) — the brain's structure proposals: single-keyword campaigns (SKCs) for key terms, the split of a
-- campaign several products share into one campaign per product, and the move of a product's campaigns into its one
-- portfolio.
--
--   AdsBrainStructure  one row per market × proposal key: its kind, status, level, the Nexus builder it goes through, the
--                      plan (the request, a split's migration plan, the owners the template declares for each lever), the
--                      evidence, the requests a person decides (the build or move, the go-live, a split's last step) and the
--                      campaigns the build made (the go-live's code rule, D1 = B, finds a brain-built campaign there).
--
-- Additive only: one new business-owned table; nothing existing is modified. The structure lever starts in shadow and its
-- requests wait for NEXUS_ADS_BRAIN_STRUCTURE_MODE=live, so with this release only shadow rows are ever written (for an
-- enrolled product) and nothing is asked or built.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainStructure" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "builder" TEXT,
    "term" TEXT,
    "campaignId" TEXT,
    "builtCampaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "approvalId" TEXT,
    "liveApprovalId" TEXT,
    "retireApprovalId" TEXT,
    "heldBy" TEXT,
    "why" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainStructure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainStructure_productId_marketplace_status_idx" ON "AdsBrainStructure"("productId", "marketplace", "status");

-- CreateIndex
CREATE INDEX "AdsBrainStructure_marketplace_kind_decidedAt_idx" ON "AdsBrainStructure"("marketplace", "kind", "decidedAt");

-- CreateIndex
CREATE INDEX "AdsBrainStructure_approvalId_idx" ON "AdsBrainStructure"("approvalId");

-- CreateIndex
CREATE INDEX "AdsBrainStructure_liveApprovalId_idx" ON "AdsBrainStructure"("liveApprovalId");

-- CreateIndex
CREATE INDEX "AdsBrainStructure_checkedAt_idx" ON "AdsBrainStructure"("checkedAt");

-- CreateIndex
CREATE INDEX "AdsBrainStructure_workspaceId_idx" ON "AdsBrainStructure"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainStructure_workspaceId_marketplace_key_key" ON "AdsBrainStructure"("workspaceId", "marketplace", "key");



-- ── (2) Row-level security for AdsBrainStructure ─────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainStructure" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainStructure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainStructure" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainStructure";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainStructure" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainStructure"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainStructure"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainStructure";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainStructure" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
