-- META ADS M1 (2026-10-20) — connect a Meta system user per business and READ its ad account (read-only; nothing in
-- this release sends a change to Meta: the gateway lets only GET through).
--
--   MetaAccountLink      the Meta ad account, Facebook Page and Instagram account a business picked through its Meta
--                        system user (one per product per business; foreign key to ChannelConnection, cascade).
--   MetaAdAccount        one Meta ad account a business reads, its settings as last read, and the state of its daily
--                        read (the contiguous range of campaign days read, so a day with no numbers is "zero" only inside it).
--   MetaAdsCampaign      the account's campaigns, as the last read saw them.
--   MetaAdsAdSet         the account's ad sets, as the last read saw them.
--   MetaAdsAd            the account's ads with a summary of their creative, as the last read saw them.
--   MetaAdsDailyMetric   one day of numbers per entity (CAMPAIGN, ADSET, AD).
--   MetaAdsReadState     the state of each step of the daily read ("not read yet" is never zero).
--
-- Additive only: seven new business-owned tables and one back-relation; nothing existing is changed or dropped. With
-- no rows, every current screen and job behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma; (2) row-level security for each new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern), each after its runtime-role grant.

-- CreateTable
CREATE TABLE "MetaAccountLink" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "metadata" JSONB,
    "selectedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAccountLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAdAccount" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "name" TEXT,
    "currencyCode" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "timezoneOffsetHoursUtc" DECIMAL(5,2),
    "accountStatus" INTEGER,
    "disableReason" INTEGER,
    "businessId" TEXT,
    "businessName" TEXT,
    "amountSpentMicros" BIGINT,
    "spendCapMicros" BIGINT,
    "balanceMicros" BIGINT,
    "minDailyBudgetMicros" BIGINT,
    "isPrepayAccount" BOOLEAN,
    "settings" JSONB,
    "settingsReadAt" TIMESTAMP(3),
    "backfillCompletedAt" TIMESTAMP(3),
    "structureSyncedAt" TIMESTAMP(3),
    "metricsReadFrom" DATE,
    "metricsReadThrough" DATE,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "callsLastRun" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAdsCampaign" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "effectiveStatus" TEXT,
    "objective" TEXT,
    "buyingType" TEXT,
    "bidStrategy" TEXT,
    "dailyBudgetMicros" BIGINT,
    "lifetimeBudgetMicros" BIGINT,
    "budgetRemainingMicros" BIGINT,
    "spendCapMicros" BIGINT,
    "startTime" TIMESTAMP(3),
    "stopTime" TIMESTAMP(3),
    "createdTimeMeta" TIMESTAMP(3),
    "updatedTimeMeta" TIMESTAMP(3),
    "currencyCode" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAdsCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAdsAdSet" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adSetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "effectiveStatus" TEXT,
    "optimizationGoal" TEXT,
    "billingEvent" TEXT,
    "bidStrategy" TEXT,
    "bidAmountMicros" BIGINT,
    "dailyBudgetMicros" BIGINT,
    "lifetimeBudgetMicros" BIGINT,
    "budgetRemainingMicros" BIGINT,
    "destinationType" TEXT,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "targeting" JSONB,
    "currencyCode" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAdsAdSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAdsAd" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adSetId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "effectiveStatus" TEXT,
    "creativeId" TEXT,
    "creative" JSONB,
    "issues" JSONB,
    "createdTimeMeta" TIMESTAMP(3),
    "updatedTimeMeta" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAdsAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAdsDailyMetric" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adSetId" TEXT,
    "label" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER,
    "spendMicros" BIGINT NOT NULL DEFAULT 0,
    "purchases" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "purchaseValueMicros" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "extra" JSONB,
    "pulledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaAdsDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAdsReadState" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "readFrom" DATE,
    "readThrough" DATE,
    "readAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "rows" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAdsReadState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaAccountLink_workspaceId_idx" ON "MetaAccountLink"("workspaceId");

-- CreateIndex
CREATE INDEX "MetaAccountLink_connectionId_idx" ON "MetaAccountLink"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAccountLink_workspaceId_product_key" ON "MetaAccountLink"("workspaceId", "product");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAccountLink_product_externalId_key" ON "MetaAccountLink"("product", "externalId");

-- CreateIndex
CREATE INDEX "MetaAdAccount_workspaceId_idx" ON "MetaAdAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "MetaAdAccount_connectionId_idx" ON "MetaAdAccount"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdAccount_workspaceId_adAccountId_key" ON "MetaAdAccount"("workspaceId", "adAccountId");

-- CreateIndex
CREATE INDEX "MetaAdsCampaign_workspaceId_idx" ON "MetaAdsCampaign"("workspaceId");

-- CreateIndex
CREATE INDEX "MetaAdsCampaign_adAccountId_status_idx" ON "MetaAdsCampaign"("adAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdsCampaign_workspaceId_adAccountId_campaignId_key" ON "MetaAdsCampaign"("workspaceId", "adAccountId", "campaignId");

-- CreateIndex
CREATE INDEX "MetaAdsAdSet_workspaceId_idx" ON "MetaAdsAdSet"("workspaceId");

-- CreateIndex
CREATE INDEX "MetaAdsAdSet_adAccountId_campaignId_idx" ON "MetaAdsAdSet"("adAccountId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdsAdSet_workspaceId_adAccountId_adSetId_key" ON "MetaAdsAdSet"("workspaceId", "adAccountId", "adSetId");

-- CreateIndex
CREATE INDEX "MetaAdsAd_workspaceId_idx" ON "MetaAdsAd"("workspaceId");

-- CreateIndex
CREATE INDEX "MetaAdsAd_adAccountId_adSetId_idx" ON "MetaAdsAd"("adAccountId", "adSetId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdsAd_workspaceId_adAccountId_adId_key" ON "MetaAdsAd"("workspaceId", "adAccountId", "adId");

-- CreateIndex
CREATE INDEX "MetaAdsDailyMetric_workspaceId_idx" ON "MetaAdsDailyMetric"("workspaceId");

-- CreateIndex
CREATE INDEX "MetaAdsDailyMetric_adAccountId_entityType_date_idx" ON "MetaAdsDailyMetric"("adAccountId", "entityType", "date");

-- CreateIndex
CREATE INDEX "MetaAdsDailyMetric_campaignId_date_idx" ON "MetaAdsDailyMetric"("campaignId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdsDailyMetric_workspaceId_adAccountId_entityType_entit_key" ON "MetaAdsDailyMetric"("workspaceId", "adAccountId", "entityType", "entityId", "date");

-- CreateIndex
CREATE INDEX "MetaAdsReadState_workspaceId_idx" ON "MetaAdsReadState"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdsReadState_workspaceId_adAccountId_resource_key" ON "MetaAdsReadState"("workspaceId", "adAccountId", "resource");

-- AddForeignKey
ALTER TABLE "MetaAccountLink" ADD CONSTRAINT "MetaAccountLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for MetaAccountLink ───────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MetaAccountLink" TO nexus_workspace_runtime;
ALTER TABLE "MetaAccountLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaAccountLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MetaAccountLink";
CREATE POLICY nexus_workspace_isolation ON "MetaAccountLink" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAccountLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAccountLink"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MetaAccountLink";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MetaAccountLink" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"connectionId","to":"id"}]');

-- ── (2) Row-level security for MetaAdAccount ─────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MetaAdAccount" TO nexus_workspace_runtime;
ALTER TABLE "MetaAdAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaAdAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MetaAdAccount";
CREATE POLICY nexus_workspace_isolation ON "MetaAdAccount" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdAccount"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdAccount"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MetaAdAccount";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MetaAdAccount" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for MetaAdsCampaign ───────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MetaAdsCampaign" TO nexus_workspace_runtime;
ALTER TABLE "MetaAdsCampaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaAdsCampaign" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MetaAdsCampaign";
CREATE POLICY nexus_workspace_isolation ON "MetaAdsCampaign" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsCampaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsCampaign"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MetaAdsCampaign";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MetaAdsCampaign" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for MetaAdsAdSet ──────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MetaAdsAdSet" TO nexus_workspace_runtime;
ALTER TABLE "MetaAdsAdSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaAdsAdSet" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MetaAdsAdSet";
CREATE POLICY nexus_workspace_isolation ON "MetaAdsAdSet" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsAdSet"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsAdSet"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MetaAdsAdSet";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MetaAdsAdSet" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for MetaAdsAd ─────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MetaAdsAd" TO nexus_workspace_runtime;
ALTER TABLE "MetaAdsAd" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaAdsAd" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MetaAdsAd";
CREATE POLICY nexus_workspace_isolation ON "MetaAdsAd" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsAd"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsAd"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MetaAdsAd";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MetaAdsAd" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for MetaAdsDailyMetric ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MetaAdsDailyMetric" TO nexus_workspace_runtime;
ALTER TABLE "MetaAdsDailyMetric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaAdsDailyMetric" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MetaAdsDailyMetric";
CREATE POLICY nexus_workspace_isolation ON "MetaAdsDailyMetric" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsDailyMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsDailyMetric"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MetaAdsDailyMetric";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MetaAdsDailyMetric" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for MetaAdsReadState ──────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MetaAdsReadState" TO nexus_workspace_runtime;
ALTER TABLE "MetaAdsReadState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaAdsReadState" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MetaAdsReadState";
CREATE POLICY nexus_workspace_isolation ON "MetaAdsReadState" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsReadState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaAdsReadState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MetaAdsReadState";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MetaAdsReadState" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
