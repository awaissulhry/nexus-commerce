-- ONE BRAIN AB-13 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §2.3, §8 row AB-13, D3 = B+) — the brain's
-- research of a market's hourly dynamics for one product, and the hourly plan it painted from it.
--
--   AdsBrainHourProposal  at most one row per product × market a week: the research (traffic, cost per click and
--                         conversion per hour of the week, pooled product → category → market, with its confidence),
--                         the painted week before and after with the expected effect, and its status. A PROPOSED row
--                         carries an approval request; only that approval, run as the person who approved it, saves the
--                         painted week as a new plan version through the Hourly Bids page's own save.
--
-- Additive only: one new business-owned table; nothing existing is modified. Nothing is written to Amazon, and no plan
-- changes without a person's approval. With no product enrolled no row is ever written.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainHourProposal" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "planId" TEXT,
    "level" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "approvalId" TEXT,
    "planBasis" TEXT,
    "research" JSONB NOT NULL,
    "paint" JSONB,
    "versionId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainHourProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainHourProposal_productId_marketplace_createdAt_idx" ON "AdsBrainHourProposal"("productId", "marketplace", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainHourProposal_planId_createdAt_idx" ON "AdsBrainHourProposal"("planId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainHourProposal_approvalId_idx" ON "AdsBrainHourProposal"("approvalId");

-- CreateIndex
CREATE INDEX "AdsBrainHourProposal_workspaceId_idx" ON "AdsBrainHourProposal"("workspaceId");


-- ── (2) Row-level security for AdsBrainHourProposal ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainHourProposal" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainHourProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainHourProposal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainHourProposal";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainHourProposal" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainHourProposal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainHourProposal"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainHourProposal";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainHourProposal" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
