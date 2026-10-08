-- ONE BRAIN batch-1 follow-up (2026-10-08) — two small business-owned tables behind two review findings.
--
--   AmazonAdsGrainCap  BB-16: a data day on which the Marketing Stream grain ingest refused records at its ceiling
--                      (kind `rows`: new grain rows past NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY; `arrivals`: arrival-log rows
--                      past NEXUS_AMS_GRAIN_MAX_ARRIVALS_PER_DAY), so a reader can tell the day was capped instead of
--                      reading a quietly incomplete day. One row per business, day and kind; pruned with the grain.
--   AdsBrainAsk        AB-8: the money writer's "ask once" as a unique key per business, so two runs at once ask one
--                      request, and a request the gate or a person refused is not asked again under the same key.
--
-- Additive only: two new tables; nothing existing is modified. Production today: the grain ceiling has never been
-- reached (no row is written until it is), and no product is enrolled in the brain (nothing is asked).
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AmazonAdsGrainCap" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "cap" INTEGER NOT NULL,
    "refused" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonAdsGrainCap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsBrainAsk" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "portfolioId" TEXT,
    "day" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "approvalId" TEXT,
    "toCents" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainAsk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmazonAdsGrainCap_workspaceId_date_idx" ON "AmazonAdsGrainCap"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonAdsGrainCap_day_kind_key" ON "AmazonAdsGrainCap"("workspaceId", "date", "kind");

-- CreateIndex
CREATE INDEX "AdsBrainAsk_productId_marketplace_day_idx" ON "AdsBrainAsk"("productId", "marketplace", "day");

-- CreateIndex
CREATE INDEX "AdsBrainAsk_workspaceId_idx" ON "AdsBrainAsk"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainAsk_workspaceId_key_key" ON "AdsBrainAsk"("workspaceId", "key");



-- ── (2) Row-level security for the business-owned tables ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AmazonAdsGrainCap" TO nexus_workspace_runtime;
ALTER TABLE "AmazonAdsGrainCap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmazonAdsGrainCap" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AmazonAdsGrainCap";
CREATE POLICY nexus_workspace_isolation ON "AmazonAdsGrainCap" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsGrainCap"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AmazonAdsGrainCap"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AmazonAdsGrainCap";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AmazonAdsGrainCap" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainAsk" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainAsk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainAsk" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainAsk";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainAsk" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainAsk"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainAsk"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainAsk";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainAsk" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
