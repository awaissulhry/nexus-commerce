-- GOOGLE ADS STEP 1b (2026-10-13) — read the detail below the campaign (read-only; nothing in this release sends a
-- change to Google).
--
--   GoogleAdsReadState       the state of each step of the daily read per account (what was read, the days read, the
--                            last attempt), so a grain never read is "not read yet", never zero.
--   GoogleAdsAdGroup         the campaigns' ad groups.
--   GoogleAdsAssetGroup      the Performance Max asset groups.
--   GoogleAdsKeyword         keywords and negatives: ad-group keywords and negatives, campaign negatives and brand
--                            lists, and the keywords of negative keyword lists.
--   GoogleAdsNegativeList    the negative keyword lists and the campaigns they are attached to.
--   GoogleAdsPolicyIssue     ads and products Google disapproved or limited (resolvedAt once no longer returned).
--   GoogleAdsRecommendation  Google's open recommendations (a snapshot, replaced whole on each read).
--   GoogleAdsAutoApply       the recommendation types Google applies on its own (auto-apply).
--   GoogleAdsCampaign        + ten nullable columns: the settings by which Google acts on its own (AI Max, broad match,
--                            networks, asset automation, dynamic search ads) and when they were read.
--
-- Additive only: eight new business-owned tables and ten nullable columns; nothing existing is changed or dropped.
-- With no rows, every current screen and job behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma; (2) row-level security for each new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern), each after its runtime-role grant.

-- AlterTable
ALTER TABLE "GoogleAdsCampaign" ADD COLUMN     "aiMaxEnabled" BOOLEAN,
ADD COLUMN     "assetAutomation" JSONB,
ADD COLUMN     "broadMatchMigratedAt" TIMESTAMP(3),
ADD COLUMN     "dsaDomain" TEXT,
ADD COLUMN     "flagsReadAt" TIMESTAMP(3),
ADD COLUMN     "keywordMatchType" TEXT,
ADD COLUMN     "targetContentNetwork" BOOLEAN,
ADD COLUMN     "targetGoogleSearch" BOOLEAN,
ADD COLUMN     "targetPartnerSearchNetwork" BOOLEAN,
ADD COLUMN     "targetSearchNetwork" BOOLEAN;

-- CreateTable
CREATE TABLE "GoogleAdsReadState" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
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

    CONSTRAINT "GoogleAdsReadState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsAdGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT,
    "primaryStatus" TEXT,
    "primaryStatusReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cpcBidMicros" BIGINT,
    "targetCpaMicros" BIGINT,
    "targetRoas" DECIMAL(10,4),
    "searchTermMatchingDisabled" BOOLEAN,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsAdGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsAssetGroup" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "assetGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "primaryStatus" TEXT,
    "primaryStatusReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "adStrength" TEXT,
    "finalUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsAssetGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsKeyword" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "parentKey" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "campaignId" TEXT,
    "adGroupId" TEXT,
    "sharedSetId" TEXT,
    "negative" BOOLEAN NOT NULL,
    "criterionType" TEXT NOT NULL,
    "text" TEXT,
    "matchType" TEXT,
    "status" TEXT,
    "cpcBidMicros" BIGINT,
    "effectiveCpcBidMicros" BIGINT,
    "qualityScore" INTEGER,
    "systemServingStatus" TEXT,
    "approvalStatus" TEXT,
    "primaryStatus" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsNegativeList" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sharedSetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "memberCount" INTEGER,
    "campaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsNegativeList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsPolicyIssue" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "campaignId" TEXT,
    "adGroupId" TEXT,
    "adId" TEXT,
    "adType" TEXT,
    "itemId" TEXT,
    "label" TEXT,
    "status" TEXT NOT NULL,
    "reviewStatus" TEXT,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "issues" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsPolicyIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsRecommendation" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "campaignId" TEXT,
    "adGroupId" TEXT,
    "dismissed" BOOLEAN NOT NULL,
    "impact" JSONB,
    "readAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleAdsRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAdsAutoApply" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAtGoogle" TIMESTAMP(3),
    "modifiedAtGoogle" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsAutoApply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleAdsReadState_workspaceId_idx" ON "GoogleAdsReadState"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsReadState_workspaceId_customerId_resource_key" ON "GoogleAdsReadState"("workspaceId", "customerId", "resource");

-- CreateIndex
CREATE INDEX "GoogleAdsAdGroup_workspaceId_idx" ON "GoogleAdsAdGroup"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAdsAdGroup_customerId_campaignId_idx" ON "GoogleAdsAdGroup"("customerId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsAdGroup_workspaceId_customerId_adGroupId_key" ON "GoogleAdsAdGroup"("workspaceId", "customerId", "adGroupId");

-- CreateIndex
CREATE INDEX "GoogleAdsAssetGroup_workspaceId_idx" ON "GoogleAdsAssetGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsAssetGroup_workspaceId_customerId_assetGroupId_key" ON "GoogleAdsAssetGroup"("workspaceId", "customerId", "assetGroupId");

-- CreateIndex
CREATE INDEX "GoogleAdsKeyword_workspaceId_idx" ON "GoogleAdsKeyword"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAdsKeyword_customerId_campaignId_idx" ON "GoogleAdsKeyword"("customerId", "campaignId");

-- CreateIndex
CREATE INDEX "GoogleAdsKeyword_customerId_adGroupId_idx" ON "GoogleAdsKeyword"("customerId", "adGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsKeyword_workspaceId_customerId_parentKey_criterion_key" ON "GoogleAdsKeyword"("workspaceId", "customerId", "parentKey", "criterionId");

-- CreateIndex
CREATE INDEX "GoogleAdsNegativeList_workspaceId_idx" ON "GoogleAdsNegativeList"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsNegativeList_workspaceId_customerId_sharedSetId_key" ON "GoogleAdsNegativeList"("workspaceId", "customerId", "sharedSetId");

-- CreateIndex
CREATE INDEX "GoogleAdsPolicyIssue_workspaceId_idx" ON "GoogleAdsPolicyIssue"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAdsPolicyIssue_customerId_kind_resolvedAt_idx" ON "GoogleAdsPolicyIssue"("customerId", "kind", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsPolicyIssue_workspaceId_customerId_kind_entityKey_key" ON "GoogleAdsPolicyIssue"("workspaceId", "customerId", "kind", "entityKey");

-- CreateIndex
CREATE INDEX "GoogleAdsRecommendation_workspaceId_idx" ON "GoogleAdsRecommendation"("workspaceId");

-- CreateIndex
CREATE INDEX "GoogleAdsRecommendation_customerId_type_idx" ON "GoogleAdsRecommendation"("customerId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsRecommendation_workspaceId_customerId_resourceName_key" ON "GoogleAdsRecommendation"("workspaceId", "customerId", "resourceName");

-- CreateIndex
CREATE INDEX "GoogleAdsAutoApply_workspaceId_idx" ON "GoogleAdsAutoApply"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAdsAutoApply_workspaceId_customerId_type_key" ON "GoogleAdsAutoApply"("workspaceId", "customerId", "type");


-- ── (2) Row-level security for GoogleAdsReadState ───────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsReadState" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsReadState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsReadState" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsReadState";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsReadState" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsReadState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsReadState"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsReadState";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsReadState" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsAdGroup ─────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsAdGroup" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsAdGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsAdGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsAdGroup";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsAdGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsAdGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsAdGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsAdGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsAdGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsAssetGroup ──────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsAssetGroup" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsAssetGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsAssetGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsAssetGroup";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsAssetGroup" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsAssetGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsAssetGroup"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsAssetGroup";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsAssetGroup" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsKeyword ─────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsKeyword" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsKeyword" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsKeyword" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsKeyword";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsKeyword" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsKeyword"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsKeyword"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsKeyword";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsKeyword" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsNegativeList ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsNegativeList" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsNegativeList" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsNegativeList" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsNegativeList";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsNegativeList" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsNegativeList"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsNegativeList"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsNegativeList";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsNegativeList" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsPolicyIssue ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsPolicyIssue" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsPolicyIssue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsPolicyIssue" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsPolicyIssue";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsPolicyIssue" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsPolicyIssue"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsPolicyIssue"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsPolicyIssue";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsPolicyIssue" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsRecommendation ──────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsRecommendation" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsRecommendation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsRecommendation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsRecommendation";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsRecommendation" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsRecommendation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsRecommendation"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsRecommendation";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsRecommendation" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for GoogleAdsAutoApply ───────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GoogleAdsAutoApply" TO nexus_workspace_runtime;
ALTER TABLE "GoogleAdsAutoApply" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleAdsAutoApply" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "GoogleAdsAutoApply";
CREATE POLICY nexus_workspace_isolation ON "GoogleAdsAutoApply" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsAutoApply"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "GoogleAdsAutoApply"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "GoogleAdsAutoApply";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "GoogleAdsAutoApply" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
