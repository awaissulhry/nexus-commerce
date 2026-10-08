-- BID BRAIN BB-22 (2026-10-08, design 2026-10-07-hands-off/BRAIN-UPGRADES-DESIGN.md U4, U4-D1 = A; one-brain DESIGN.md
-- §2.3, D3 = B+) — BidBrainHourFactor: the hour factors the bid brain learned for one product (family root) in one market —
-- per hour of the week a smooth conversion curve pooled product → category → market, a cost-per-unit-of-bid curve from the
-- product's own hours, the factor they give with its 90 % interval, each of its campaigns' plans against it, and top of
-- search's pooled conversion with the placement cap it sets. Learned at most once a day in the bid brain's full run (and
-- when a plan changes); replaced by each learning (no history). Read by the bid brain under NEXUS_BID_BRAIN_HOUR_FACTORS
-- (shadow by default: words in the why, nothing changed; on: the approved plan's lanes moved inside each cell's limits where
-- the product's brain owns the hours lever) and by the bid-brain read tool's hour-factors view.
-- Additive only: one new business-owned table; nothing existing is modified. With no rows the brain runs every plan exactly
-- as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "BidBrainHourFactor" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "campaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "windowFrom" TEXT,
    "windowTo" TEXT,
    "factors" JSONB NOT NULL,
    "learnedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BidBrainHourFactor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BidBrainHourFactor_marketplace_idx" ON "BidBrainHourFactor"("marketplace");

-- CreateIndex
CREATE INDEX "BidBrainHourFactor_workspaceId_idx" ON "BidBrainHourFactor"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BidBrainHourFactor_product_key" ON "BidBrainHourFactor"("workspaceId", "productId", "marketplace");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BidBrainHourFactor" TO nexus_workspace_runtime;
ALTER TABLE "BidBrainHourFactor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BidBrainHourFactor" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BidBrainHourFactor";
CREATE POLICY nexus_workspace_isolation ON "BidBrainHourFactor" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidBrainHourFactor"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidBrainHourFactor"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BidBrainHourFactor";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BidBrainHourFactor" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
