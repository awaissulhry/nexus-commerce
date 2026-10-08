-- ONE BRAIN AB-7 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §2.5, §2.6, §4, §5, §8 row AB-7) — the money
-- hierarchy in SHADOW: what each enrolled product's brain would do with its money this month.
--
--   AdsBrainBudgetDecision  one row per product × market when its money plan's decisions change, plus the budget day's
--                           first as a snapshot: the envelope, the pace and its brake, the Amazon portfolio-cap plan and
--                           each campaign's daily budget with the intraday ladder, every part with its why. Only for a
--                           product whose budgets lever is OBSERVE or higher; rows older than 30 days are deleted.
--
-- Additive only: one new business-owned table; nothing existing is modified. Nothing is written to Amazon (AB-8 writes).
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainBudgetDecision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "month" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "envelopeCents" INTEGER,
    "envelopeSource" TEXT NOT NULL,
    "spentCents" INTEGER NOT NULL,
    "projectedCents" INTEGER NOT NULL,
    "pacePct" DECIMAL(10,2),
    "brake" TEXT NOT NULL,
    "portfolioCapCents" INTEGER,
    "planHash" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "why" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsBrainBudgetDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainBudgetDecision_productId_marketplace_createdAt_idx" ON "AdsBrainBudgetDecision"("productId", "marketplace", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainBudgetDecision_runId_idx" ON "AdsBrainBudgetDecision"("runId");

-- CreateIndex
CREATE INDEX "AdsBrainBudgetDecision_createdAt_idx" ON "AdsBrainBudgetDecision"("createdAt");

-- CreateIndex
CREATE INDEX "AdsBrainBudgetDecision_workspaceId_idx" ON "AdsBrainBudgetDecision"("workspaceId");



-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainBudgetDecision" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainBudgetDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainBudgetDecision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainBudgetDecision";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainBudgetDecision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainBudgetDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainBudgetDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainBudgetDecision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainBudgetDecision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
