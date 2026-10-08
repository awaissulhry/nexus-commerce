-- ONE BRAIN AB-11 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §2.8, §2.9, §4, §5, §8 row AB-11) — the harvest
-- module's record: one row per harvest of one term of one product (family root) in one market.
--
--   AdsBrainHarvest   where the term goes (an existing exact ad group of the product, or a new campaign through a Nexus
--                     builder, by approval), the start bid, every source that gets the negative exact in the same change
--                     set, the request a person decides (PROPOSE), the pair's write state (DONE, HALF_DONE retried), and
--                     the judgement after the attribution window + 72 h with its evidence. The unique key (business,
--                     product, market, term) keeps one harvest per term: a term is placed once and never moved again.
--
-- Written by the harvest run (services/advertising/brain/harvest-run.ts) for products whose harvest lever is OBSERVE or
-- higher, and by the apply-brain-harvest request a person approves. With no product enrolled (production today) nothing
-- is written; at OBSERVE (the default) only shadow rows are written; nothing reaches Amazon unless the harvest lever is
-- PROPOSE or AUTO AND the env ceiling NEXUS_ADS_BRAIN_HARVEST_MODE is live.
--
-- Additive only: one new business-owned table; nothing existing is modified.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- packages/database/scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets.

-- CreateTable
CREATE TABLE "AdsBrainHarvest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "isAsin" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "destinationKind" TEXT NOT NULL,
    "destHow" TEXT,
    "destCampaignId" TEXT,
    "destAdGroupId" TEXT,
    "bidCents" INTEGER,
    "keywordTargetId" TEXT,
    "landedAt" TIMESTAMP(3),
    "sources" JSONB NOT NULL,
    "approvalId" TEXT,
    "undoApprovalId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "heldBy" TEXT,
    "why" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "judgeAfter" TIMESTAMP(3),
    "judgedAt" TIMESTAMP(3),
    "verdict" TEXT,
    "judgement" JSONB,
    "digest" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainHarvest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainHarvest_marketplace_status_idx" ON "AdsBrainHarvest"("marketplace", "status");

-- CreateIndex
CREATE INDEX "AdsBrainHarvest_status_judgeAfter_idx" ON "AdsBrainHarvest"("status", "judgeAfter");

-- CreateIndex
CREATE INDEX "AdsBrainHarvest_checkedAt_idx" ON "AdsBrainHarvest"("checkedAt");

-- CreateIndex
CREATE INDEX "AdsBrainHarvest_workspaceId_idx" ON "AdsBrainHarvest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainHarvest_workspaceId_productId_marketplace_term_key" ON "AdsBrainHarvest"("workspaceId", "productId", "marketplace", "term");



-- ── (2) Row-level security for the business-owned table ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainHarvest" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainHarvest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainHarvest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainHarvest";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainHarvest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainHarvest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainHarvest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainHarvest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainHarvest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
