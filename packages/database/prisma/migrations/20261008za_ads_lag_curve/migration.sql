-- BID BRAIN BB-15 (2026-10-08, design 2026-10-07-hands-off/BRAIN-UPGRADES-DESIGN.md U1b) — AdsLagCurve: the attribution
-- lag curve L(a) of one market (or of one product in it with enough orders of its own) — the expected share of a day's
-- final 7-day orders and sales that a copy pulled at age a days holds, a = 0..14. Fitted each night from AdsDailyVintage,
-- seeded from the settled 1-day ÷ 7-day ratio; replaced by each fit (no history). Read by the bid brain's nowcast (off
-- unless NEXUS_BID_BRAIN_NOWCAST is shadow or on) and by the bid-brain read tool's calibration view.
-- Additive only: one new business-owned table; nothing existing is modified. With no rows the brain reads its settled
-- window exactly as before (no usable curve → young days ignored).
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsLagCurve" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    "scopeId" TEXT NOT NULL DEFAULT '*',
    "source" TEXT NOT NULL,
    "shares" JSONB NOT NULL,
    "usable" BOOLEAN NOT NULL DEFAULT false,
    "basis" JSONB NOT NULL,
    "calibration" JSONB,
    "fittedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsLagCurve_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "AdsLagCurve_workspaceId_idx" ON "AdsLagCurve"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsLagCurve_scope_key" ON "AdsLagCurve"("workspaceId", "marketplace", "adProduct", "scopeId");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsLagCurve" TO nexus_workspace_runtime;
ALTER TABLE "AdsLagCurve" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsLagCurve" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsLagCurve";
CREATE POLICY nexus_workspace_isolation ON "AdsLagCurve" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsLagCurve"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsLagCurve"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsLagCurve";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsLagCurve" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
