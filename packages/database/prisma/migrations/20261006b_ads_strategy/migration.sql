-- ADS AUTONOMY W1-1 — one home for the Amazon Ads strategy: AdsStrategy (the current values per market, category or
-- product, in one market) and AdsStrategyVersion (every change, append-only). Additive only: two new business-owned
-- tables; nothing existing is modified. With no rows every current screen, engine and Claude call behaves exactly as
-- before — no code reads these tables in this release.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security for both, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets
-- (the 20260923a pattern). Neither table has a foreign key (the scope id is polymorphic; the history outlives a removed
-- row), so the reference guard has nothing to check.

-- CreateTable
CREATE TABLE "AdsStrategy" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'AMAZON',
    "market" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '*',
    "label" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "goal" TEXT,
    "goalNote" TEXT,
    "targetKind" TEXT,
    "targetPct" INTEGER,
    "monthlySpendCapCents" INTEGER,
    "minBidCents" INTEGER,
    "maxBidCents" INTEGER,
    "maxChangePct" INTEGER,
    "maxActionsPerRun" INTEGER,
    "protect" BOOLEAN,
    "harvestMinOrders" INTEGER,
    "harvestMinClicks" INTEGER,
    "harvestMaxAcosPct" INTEGER,
    "harvestWindowDays" INTEGER,
    "negateMinClicks" INTEGER,
    "negateMinSpendCents" INTEGER,
    "negateMaxOrders" INTEGER,
    "negateWindowDays" INTEGER,
    "stopMethod" TEXT,
    "stopBidCents" INTEGER,
    "claudeAutonomy" JSONB,
    "reviewEveryDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "AdsStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsStrategyVersion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "values" JSONB,
    "changes" JSONB NOT NULL,
    "direction" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "approvalId" TEXT,
    "actor" TEXT NOT NULL,
    "actorUserId" TEXT,
    "stepUpAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsStrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsStrategy_market_level_idx" ON "AdsStrategy"("market", "level");

-- CreateIndex
CREATE INDEX "AdsStrategy_workspaceId_idx" ON "AdsStrategy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsStrategy_channel_market_level_scopeId_key" ON "AdsStrategy"("workspaceId", "channel", "market", "level", "scopeId");

-- CreateIndex
CREATE INDEX "AdsStrategyVersion_market_level_scopeId_createdAt_idx" ON "AdsStrategyVersion"("market", "level", "scopeId", "createdAt");

-- CreateIndex
CREATE INDEX "AdsStrategyVersion_workspaceId_idx" ON "AdsStrategyVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsStrategyVersion_strategyId_version_key" ON "AdsStrategyVersion"("workspaceId", "strategyId", "version");



-- ── (2) Row-level security for the business-owned tables ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsStrategy" TO nexus_workspace_runtime;
ALTER TABLE "AdsStrategy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsStrategy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsStrategy";
CREATE POLICY nexus_workspace_isolation ON "AdsStrategy" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsStrategy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsStrategy"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsStrategy";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsStrategy" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsStrategyVersion" TO nexus_workspace_runtime;
ALTER TABLE "AdsStrategyVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsStrategyVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsStrategyVersion";
CREATE POLICY nexus_workspace_isolation ON "AdsStrategyVersion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsStrategyVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsStrategyVersion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsStrategyVersion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsStrategyVersion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
