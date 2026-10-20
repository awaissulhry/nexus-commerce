-- SD reports below the campaign (2026-10-20) — Sponsored Display results per ad group, target and advertised product
-- (AmazonAdsSdDailyPerformance), and what shoppers bought after an SD ad (AmazonAdsSdPurchasedProduct), from Amazon's
-- sdAdGroup, sdTargeting, sdAdvertisedProduct and sdPurchasedProduct reports. Every figure keeps Display's 14-day
-- attribution, after a click or a view, and the after-a-click share beside it.
-- Additive only: two new business-owned tables; nothing existing is modified, and with no rows every screen and job
-- behaves exactly as before.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AmazonAdsSdDailyPerformance" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "localEntityId" TEXT,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "entityName" TEXT,
    "targetingExpression" TEXT,
    "entityStatus" TEXT,
    "promotedAsin" TEXT,
    "promotedSku" TEXT,
    "currencyCode" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "viewableImpressions" INTEGER,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "sales14dCents" INTEGER,
    "salesClicks14dCents" INTEGER,
    "orders14d" INTEGER,
    "ordersClicks14d" INTEGER,
    "units14d" INTEGER,
    "unitsClicks14d" INTEGER,
    "detailPageViews14d" INTEGER,
    "detailPageViewsClicks14d" INTEGER,
    "ntbOrders14d" INTEGER,
    "ntbOrdersClicks14d" INTEGER,
    "ntbSalesCents14d" INTEGER,
    "ntbSalesClicksCents14d" INTEGER,
    "ntbUnits14d" INTEGER,
    "ntbUnitsClicks14d" INTEGER,
    "reportRunId" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonAdsSdDailyPerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonAdsSdPurchasedProduct" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "promotedAsin" TEXT NOT NULL,
    "promotedSku" TEXT,
    "purchasedAsin" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "sales14dCents" INTEGER,
    "salesClicks14dCents" INTEGER,
    "orders14d" INTEGER,
    "ordersClicks14d" INTEGER,
    "units14d" INTEGER,
    "unitsClicks14d" INTEGER,
    "reportRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmazonAdsSdPurchasedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmazonAdsSdDailyPerformance_localEntityId_date_idx" ON "AmazonAdsSdDailyPerformance"("localEntityId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsSdDailyPerformance_campaignId_date_idx" ON "AmazonAdsSdDailyPerformance"("campaignId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsSdDailyPerformance_marketplace_date_idx" ON "AmazonAdsSdDailyPerformance"("marketplace", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsSdDailyPerformance_workspaceId_idx" ON "AmazonAdsSdDailyPerformance"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsSdDailyPerformance_entity_day_key" ON "AmazonAdsSdDailyPerformance"("workspaceId", "profileId", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsSdPurchasedProduct_profileId_date_idx" ON "AmazonAdsSdPurchasedProduct"("profileId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsSdPurchasedProduct_campaignId_date_idx" ON "AmazonAdsSdPurchasedProduct"("campaignId", "date");

-- CreateIndex
CREATE INDEX "AmazonAdsSdPurchasedProduct_workspaceId_idx" ON "AmazonAdsSdPurchasedProduct"("workspaceId");


-- ── (2) Row-level security for the business-owned tables ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsSdDailyPerformance" TO nexus_workspace_runtime;
ALTER TABLE "AmazonAdsSdDailyPerformance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsSdDailyPerformance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsSdDailyPerformance";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsSdDailyPerformance" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsSdDailyPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsSdDailyPerformance"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsSdDailyPerformance";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsSdDailyPerformance" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsSdPurchasedProduct" TO nexus_workspace_runtime;
ALTER TABLE "AmazonAdsSdPurchasedProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsSdPurchasedProduct" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsSdPurchasedProduct";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsSdPurchasedProduct" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsSdPurchasedProduct"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsSdPurchasedProduct"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsSdPurchasedProduct";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsSdPurchasedProduct" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
