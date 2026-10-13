-- GOOGLE ADS STEP 1a (2026-10-13) — connect Google per business and read its Google Ads account (read-only; nothing in
-- this release sends a change to Google).
--
--   GoogleAccountLink     the Google Ads account, Merchant Center account and GA4 property a business picked through its
--                         Google login (one per product per business; foreign key to ChannelConnection, cascade).
--   GoogleAdsCustomer     one Google Ads account a business reads, and the state of its daily read (the contiguous range
--                         of days read, so a day with no numbers is "zero" only inside it).
--   GoogleAdsCampaign     the account's campaigns with their budgets, as the last read saw them.
--   GoogleAdsDailyMetric  one day of numbers per entity (step 1a writes CAMPAIGN rows only).
--   GoogleAdsChangeEvent  Google's change history (Google keeps 30 days; Nexus keeps what it read).
--
-- Additive only: five new business-owned tables and one back-relation; nothing existing is changed or dropped. With no
-- rows, every current screen and job behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma; (2) row-level security for each new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern), each after its runtime-role grant.

-- CreateTable
CREATE TABLE "GoogleAccountLink" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "loginCustomerId" TEXT,
    "label" TEXT NOT NULL,
    "metadata" JSONB,
    "selectedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAccountLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsCustomer" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "loginCustomerId" TEXT,
    "descriptiveName" TEXT,
    "currencyCode" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "manager" BOOLEAN NOT NULL DEFAULT false,
    "testAccount" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "parentCustomerId" TEXT,
    "level" INTEGER,
    "backfillCompletedAt" TIMESTAMP(3),
    "structureSyncedAt" TIMESTAMP(3),
    "metricsReadFrom" DATE,
    "metricsReadThrough" DATE,
    "changesSyncedThrough" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "opsUsedLastRun" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsCampaign" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "servingStatus" TEXT,
    "primaryStatus" TEXT,
    "primaryStatusReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channelType" TEXT NOT NULL,
    "channelSubType" TEXT,
    "biddingStrategyType" TEXT,
    "portfolioBiddingStrategy" TEXT,
    "targetCpaMicros" BIGINT,
    "targetRoas" DECIMAL(10,4),
    "budgetId" TEXT,
    "budgetAmountMicros" BIGINT,
    "budgetDeliveryMethod" TEXT,
    "budgetPeriod" TEXT,
    "budgetShared" BOOLEAN NOT NULL DEFAULT false,
    "merchantId" TEXT,
    "feedLabel" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "currencyCode" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsDailyMetric" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "label" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "conversions" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "conversionsValueMicros" BIGINT NOT NULL DEFAULT 0,
    "allConversions" DECIMAL(14,4),
    "allConversionsValueMicros" BIGINT,
    "currencyCode" TEXT NOT NULL,
    "extra" JSONB,
    "pulledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleAdsDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsChangeEvent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "resourceType" TEXT NOT NULL,
    "changeResourceName" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "clientType" TEXT,
    "userEmail" TEXT,
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "campaignId" TEXT,
    "adGroupId" TEXT,
    "oldResource" JSONB,
    "newResource" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleAdsChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleAccountLink_workspaceId_idx" ON "GoogleAccountLink"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAccountLink_connectionId_idx" ON "GoogleAccountLink"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAccountLink_workspaceId_product_key" ON "GoogleAccountLink"("workspaceId", "product");

-- CreateIndex
CREATE INDEX "GoogleAdsCustomer_workspaceId_idx" ON "GoogleAdsCustomer"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAdsCustomer_connectionId_idx" ON "GoogleAdsCustomer"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsCustomer_workspaceId_customerId_key" ON "GoogleAdsCustomer"("workspaceId", "customerId");

-- CreateIndex
CREATE INDEX "GoogleAdsCampaign_workspaceId_idx" ON "GoogleAdsCampaign"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAdsCampaign_customerId_status_idx" ON "GoogleAdsCampaign"("customerId", "status");

-- CreateIndex
CREATE INDEX "GoogleAdsCampaign_channelType_idx" ON "GoogleAdsCampaign"("channelType");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsCampaign_workspaceId_customerId_campaignId_key" ON "GoogleAdsCampaign"("workspaceId", "customerId", "campaignId");

-- CreateIndex
CREATE INDEX "GoogleAdsDailyMetric_workspaceId_idx" ON "GoogleAdsDailyMetric"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAdsDailyMetric_customerId_entityType_date_idx" ON "GoogleAdsDailyMetric"("customerId", "entityType", "date");

-- CreateIndex
CREATE INDEX "GoogleAdsDailyMetric_campaignId_date_idx" ON "GoogleAdsDailyMetric"("campaignId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsDailyMetric_workspaceId_customerId_entityType_enti_key" ON "GoogleAdsDailyMetric"("workspaceId", "customerId", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "GoogleAdsChangeEvent_workspaceId_idx" ON "GoogleAdsChangeEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAdsChangeEvent_customerId_changedAt_idx" ON "GoogleAdsChangeEvent"("customerId", "changedAt");

-- CreateIndex
CREATE INDEX "GoogleAdsChangeEvent_campaignId_changedAt_idx" ON "GoogleAdsChangeEvent"("campaignId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsChangeEvent_workspaceId_resourceName_key" ON "GoogleAdsChangeEvent"("workspaceId", "resourceName");

-- AddForeignKey
ALTER TABLE "GoogleAccountLink" ADD CONSTRAINT "GoogleAccountLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for GoogleAccountLink ────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAccountLink" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAccountLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAccountLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAccountLink";
CREATE POLICY nexus_workspace_isolation ON "GoogleAccountLink" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAccountLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAccountLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAccountLink";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAccountLink" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"connectionId","to":"id"}]');

-- ── (2) Row-level security for GoogleAdsCustomer ────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsCustomer" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsCustomer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsCustomer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsCustomer";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsCustomer" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsCustomer"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsCustomer"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsCustomer";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsCustomer" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsCampaign ────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsCampaign" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsCampaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsCampaign" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsCampaign";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsCampaign" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsCampaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsCampaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsCampaign";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsCampaign" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsDailyMetric ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsDailyMetric" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsDailyMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsDailyMetric" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsDailyMetric";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsDailyMetric" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsDailyMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsDailyMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsDailyMetric";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsDailyMetric" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsChangeEvent ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsChangeEvent" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsChangeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsChangeEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsChangeEvent";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsChangeEvent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsChangeEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsChangeEvent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsChangeEvent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsChangeEvent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
