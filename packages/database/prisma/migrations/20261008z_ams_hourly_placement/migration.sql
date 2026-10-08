-- BID BRAIN BB-16 (2026-10-08, design BRAIN-UPGRADES-DESIGN.md U1c / F2; one-brain DESIGN.md §2.3, §2.6, §8 data PRs) —
-- the Marketing Stream's Sponsored Products hours at ad group × placement grain, and when their deltas arrived.
--
--   AmazonAdsHourlyPlacement  one row per (campaign, ad group, placement, UTC hour): the Σ of every sp-traffic and
--                             sp-conversion delta, with the real 1-day and 7-day attributed conversions, and the
--                             dataset idempotency keys already summed (a redelivery adds nothing).
--   AmazonAdsHourlyArrival    the delta-arrival log: per row × kind (traffic / conversion) × age bucket, the Σ of the
--                             deltas that arrived then, so the attribution curve can be learned.
--
-- Additive only: two new business-owned tables; nothing existing is modified. AmazonAdsHourlyPerformance (campaign
-- grain) and every reader of it are unchanged — the ingest keeps writing it exactly as before and writes these beside it.
-- With no rows, nothing reads differently.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).
-- CreateTable
CREATE TABLE "AmazonAdsHourlyPlacement" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT,
    "marketplace" TEXT,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "currencyCode" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "orders1d" INTEGER NOT NULL DEFAULT 0,
    "orders7d" INTEGER NOT NULL DEFAULT 0,
    "units1d" INTEGER NOT NULL DEFAULT 0,
    "units7d" INTEGER NOT NULL DEFAULT 0,
    "sales1dCents" INTEGER NOT NULL DEFAULT 0,
    "sales7dCents" INTEGER NOT NULL DEFAULT 0,
    "appliedKeys" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "lateStart" BOOLEAN NOT NULL DEFAULT false,
    "firstArrivalAt" TIMESTAMP(3) NOT NULL,
    "lastArrivalAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonAdsHourlyPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsHourlyArrival" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "grainId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "ageHours" INTEGER NOT NULL,
    "records" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "orders1d" INTEGER NOT NULL DEFAULT 0,
    "orders7d" INTEGER NOT NULL DEFAULT 0,
    "units1d" INTEGER NOT NULL DEFAULT 0,
    "units7d" INTEGER NOT NULL DEFAULT 0,
    "sales1dCents" INTEGER NOT NULL DEFAULT 0,
    "sales7dCents" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonAdsHourlyArrival_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmazonAdsHourlyPlacement_workspaceId_date_idx" ON "AmazonAdsHourlyPlacement"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsHourlyPlacement_grain_key" ON "AmazonAdsHourlyPlacement"("workspaceId", "campaignId", "adGroupId", "placement", "date", "hour");

-- CreateIndex
CREATE INDEX "AmazonAdsHourlyArrival_workspaceId_date_idx" ON "AmazonAdsHourlyArrival"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsHourlyArrival_bucket_key" ON "AmazonAdsHourlyArrival"("workspaceId", "grainId", "kind", "ageHours");


-- ── (2) Row-level security for AmazonAdsHourlyPlacement ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsHourlyPlacement" TO nexus_workspace_runtime;
ALTER TABLE "AmazonAdsHourlyPlacement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsHourlyPlacement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsHourlyPlacement";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsHourlyPlacement" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsHourlyPlacement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsHourlyPlacement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsHourlyPlacement";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsHourlyPlacement" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for AmazonAdsHourlyArrival ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsHourlyArrival" TO nexus_workspace_runtime;
ALTER TABLE "AmazonAdsHourlyArrival" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsHourlyArrival" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsHourlyArrival";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsHourlyArrival" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsHourlyArrival"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsHourlyArrival"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsHourlyArrival";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsHourlyArrival" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
