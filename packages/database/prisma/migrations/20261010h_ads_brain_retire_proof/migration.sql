-- ONE BRAIN AB-20 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §3, §8 row AB-20; BID-BRAIN-DESIGN.md §6 BB-12) —
-- the duplicate writers a product's brain retires once every lever of the product is AUTO or the Owner's own choice.
--
--   AdsBrainRetirement  one row per configuration row the brain switched off for one product × market (an ads rule, a
--                       budget schedule, a budget pool, a classic dayparting schedule, a coverage set, an autopilot plan):
--                       what it was and what retirement set, the campaigns it reached and the levers it writes, why, the
--                       approval it ran under, and its give-back (switched on again, or left as a person changed it).
--
-- Additive only: one new business-owned table; nothing existing is modified. A retirement runs only on a person's approval
-- (retire-ads-writers) for an enrolled product whose every lever is AUTO or the Owner's choice under the live server switch,
-- so with this release (nothing enrolled in production) no row is ever written.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable

-- CreateTable
CREATE TABLE "AdsBrainRetirement" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "writer" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "campaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "levers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "why" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RETIRED',
    "approvalId" TEXT,
    "retiredBy" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "givenBackAt" TIMESTAMP(3),
    "givenBackBy" TEXT,
    "givenBackWhy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainRetirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainRetirement_productId_marketplace_status_idx" ON "AdsBrainRetirement"("productId", "marketplace", "status");

-- CreateIndex
CREATE INDEX "AdsBrainRetirement_writer_targetId_status_idx" ON "AdsBrainRetirement"("writer", "targetId", "status");

-- CreateIndex
CREATE INDEX "AdsBrainRetirement_status_idx" ON "AdsBrainRetirement"("status");

-- CreateIndex
CREATE INDEX "AdsBrainRetirement_workspaceId_idx" ON "AdsBrainRetirement"("workspaceId");



-- ── (2) Row-level security for AdsBrainRetirement ─────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainRetirement" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainRetirement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainRetirement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainRetirement";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainRetirement" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainRetirement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainRetirement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainRetirement";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainRetirement" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
