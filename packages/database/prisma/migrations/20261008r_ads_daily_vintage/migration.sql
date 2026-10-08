-- BID BRAIN BB-13 (2026-10-08, design BRAIN-UPGRADES-DESIGN.md U1a) — AdsDailyVintage: the copies of one campaign day as
-- Amazon filled it in. The daily reports now re-read the last 8 days (Sponsored Products) / 15 (Brands, Display) every
-- night and AmazonAdsDailyPerformance keeps only the newest copy; each pull that changed the numbers is kept here, with
-- the copy a re-pull replaced, so the size of the late sales can be measured and the fill curve learned.
-- Additive only: one new business-owned table; nothing existing is modified, and with no rows every screen and job
-- behaves exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsDailyVintage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "adProduct" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "pulledAt" TIMESTAMP(3) NOT NULL,
    "ageDays" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'pull',
    "reportRunId" TEXT,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "costMicros" BIGINT NOT NULL,
    "sales1dCents" INTEGER,
    "sales7dCents" INTEGER,
    "sales14dCents" INTEGER,
    "orders1d" INTEGER,
    "orders7d" INTEGER,
    "orders14d" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsDailyVintage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsDailyVintage_marketplace_date_idx" ON "AdsDailyVintage"("marketplace", "date");

-- CreateIndex
CREATE INDEX "AdsDailyVintage_createdAt_idx" ON "AdsDailyVintage"("createdAt");

-- CreateIndex
CREATE INDEX "AdsDailyVintage_workspaceId_idx" ON "AdsDailyVintage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsDailyVintage_pull_key" ON "AdsDailyVintage"("workspaceId", "profileId", "adProduct", "entityType", "entityId", "date", "pulledAt");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsDailyVintage" TO nexus_workspace_runtime;
ALTER TABLE "AdsDailyVintage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsDailyVintage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsDailyVintage";
CREATE POLICY nexus_workspace_isolation ON "AdsDailyVintage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsDailyVintage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsDailyVintage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsDailyVintage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsDailyVintage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
