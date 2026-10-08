-- Amazon Best Sellers Rank reader (2026-10-09) — AmazonSalesRank: one row per ASIN, market and read whose ranks changed
-- (or a daily heartbeat), as the Catalog Items API (searchCatalogItems, includedData=salesRanks) reports them. Written
-- every 3 hours by the sales-rank feed for the business's live Amazon listings; read by the sales-rank tool.
-- Additive only: one new business-owned table; nothing existing is modified, and with no rows every current screen and
-- job behaves exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AmazonSalesRank" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "productId" TEXT,
    "classificationRanks" JSONB NOT NULL,
    "displayGroupRanks" JSONB NOT NULL,
    "bestRank" INTEGER,
    "runId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonSalesRank_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmazonSalesRank_productId_marketplace_capturedAt_idx" ON "AmazonSalesRank"("productId", "marketplace", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "AmazonSalesRank_asin_marketplace_capturedAt_idx" ON "AmazonSalesRank"("asin", "marketplace", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "AmazonSalesRank_capturedAt_idx" ON "AmazonSalesRank"("capturedAt");

-- CreateIndex
CREATE INDEX "AmazonSalesRank_workspaceId_idx" ON "AmazonSalesRank"("workspaceId");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonSalesRank" TO nexus_workspace_runtime;
ALTER TABLE "AmazonSalesRank" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonSalesRank" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonSalesRank";
CREATE POLICY nexus_workspace_isolation ON "AmazonSalesRank" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonSalesRank"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonSalesRank"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonSalesRank";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonSalesRank" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
