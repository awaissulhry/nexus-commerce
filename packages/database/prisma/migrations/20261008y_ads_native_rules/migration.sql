-- ONE BRAIN AB-4 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §2.12, §3 point 6, §8 row AB-4) — Amazon's own rules
-- on brain campaigns, read once a day.
--
--   AdsNativeRuleSnapshot  one row per brain campaign (an enrolled product's, or one the bid brain runs LIVE or HELD): what
--                          Amazon's own budget rules on it were when Nexus last asked (GET /sp/campaigns/{id}/budgetRules,
--                          through the channel gateway), or why they could not be read. Replaced by each read; no history.
--
-- Additive only: one new business-owned table; nothing existing is modified. With no rows the ads-brain map says "could not
-- read" for Amazon's rules, as it said "could not measure" before, and no enrollment is refused.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsNativeRuleSnapshot" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "externalCampaignId" TEXT NOT NULL,
    "marketplace" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "readings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsNativeRuleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsNativeRuleSnapshot_workspaceId_idx" ON "AdsNativeRuleSnapshot"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsNativeRuleSnapshot_workspaceId_campaignId_key" ON "AdsNativeRuleSnapshot"("workspaceId", "campaignId");



-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsNativeRuleSnapshot" TO nexus_workspace_runtime;
ALTER TABLE "AdsNativeRuleSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsNativeRuleSnapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsNativeRuleSnapshot";
CREATE POLICY nexus_workspace_isolation ON "AdsNativeRuleSnapshot" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsNativeRuleSnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsNativeRuleSnapshot"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsNativeRuleSnapshot";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsNativeRuleSnapshot" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
