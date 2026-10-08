-- ONE BRAIN AB-1 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §3, §6, §8, §10) — a product's brain in one market.
--
--   AdsBrainEnrollment  one row per product (family root) × market: the product is enrolled, the version every change of
--                       its brain goes through (compare-and-set), and per lever what it held when it last went live
--   AdsBrainOverride    one choice of the Owner over a brain default, per product or per campaign (Owner 10-08: "I should
--                       be able to control it individually as well"): a lever's level, a lock at his own value, an
--                       exclusion, a setting (caps, N1–N4). Precedence campaign > product > default; never deleted
--                       (a newer choice ends the old one), so every resolved value names who, when and why
--
-- Additive only: two new business-owned tables; nothing existing is modified. With no rows every screen, engine and job
-- behaves exactly as before, and nothing reads them on a write path yet: the bids lever writes BidBrainEnrollment, which
-- the live bid brain keeps reading.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainEnrollment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "snapshots" JSONB,
    "enrolledBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "AdsBrainEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsBrainOverride" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "campaignId" TEXT,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ref" TEXT NOT NULL DEFAULT '',
    "value" JSONB,
    "by" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,

    CONSTRAINT "AdsBrainOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainEnrollment_marketplace_idx" ON "AdsBrainEnrollment"("marketplace");

-- CreateIndex
CREATE INDEX "AdsBrainEnrollment_workspaceId_idx" ON "AdsBrainEnrollment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainEnrollment_workspaceId_productId_marketplace_key" ON "AdsBrainEnrollment"("workspaceId", "productId", "marketplace");

-- CreateIndex
CREATE INDEX "AdsBrainOverride_productId_marketplace_endedAt_idx" ON "AdsBrainOverride"("productId", "marketplace", "endedAt");

-- CreateIndex
CREATE INDEX "AdsBrainOverride_campaignId_endedAt_idx" ON "AdsBrainOverride"("campaignId", "endedAt");

-- CreateIndex
CREATE INDEX "AdsBrainOverride_workspaceId_idx" ON "AdsBrainOverride"("workspaceId");



-- ── (2) Row-level security for the business-owned tables ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainEnrollment" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainEnrollment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainEnrollment";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainEnrollment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainEnrollment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainEnrollment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainEnrollment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainEnrollment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainOverride" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainOverride" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainOverride";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainOverride" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainOverride"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainOverride"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainOverride";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainOverride" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
