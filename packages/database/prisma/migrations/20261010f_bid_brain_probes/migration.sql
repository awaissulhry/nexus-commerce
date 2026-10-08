-- BID BRAIN BB-21 (2026-10-08, design 2026-10-07-hands-off/BRAIN-UPGRADES-DESIGN.md U2 "Learning ε", U3 "Switchback
-- probes") — BidProbe: the ledger of the switchback probes that measure each keyword's bid elasticity ε for the response
-- model (services/advertising/bid-brain/probe.ts, probe-store.ts). One row per keyword and start day: the arms around the
-- brain's bid, the order and what each serving day recorded, then what it measured per arm, its reading of ε and its
-- product's ε before and after. NEXUS_BID_BRAIN_PROBES=shadow (the default) writes SHADOW rows only and changes no bid.
-- Additive only: one new business-owned table; nothing existing is modified. With no rows the brain decides exactly as
-- before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "BidProbe" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "productKey" TEXT,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "centerCents" INTEGER NOT NULL,
    "highCents" INTEGER NOT NULL,
    "lowCents" INTEGER NOT NULL,
    "amplitude" DOUBLE PRECISION NOT NULL,
    "protection" TEXT,
    "sequence" TEXT NOT NULL,
    "startDay" DATE NOT NULL,
    "endDay" DATE NOT NULL,
    "days" JSONB NOT NULL DEFAULT '{}',
    "observed" JSONB,
    "reading" JSONB,
    "epsPrior" JSONB,
    "epsPosterior" JSONB,
    "why" TEXT NOT NULL,
    "stoppedWhy" TEXT,
    "runId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BidProbe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BidProbe_marketplace_status_idx" ON "BidProbe"("marketplace", "status");

-- CreateIndex
CREATE INDEX "BidProbe_targetId_createdAt_idx" ON "BidProbe"("targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BidProbe_updatedAt_idx" ON "BidProbe"("updatedAt");

-- CreateIndex
CREATE INDEX "BidProbe_workspaceId_idx" ON "BidProbe"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BidProbe_workspaceId_targetId_startDay_key" ON "BidProbe"("workspaceId", "targetId", "startDay");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BidProbe" TO nexus_workspace_runtime;
ALTER TABLE "BidProbe" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BidProbe" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BidProbe";
CREATE POLICY nexus_workspace_isolation ON "BidProbe" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidProbe"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidProbe"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BidProbe";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BidProbe" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
