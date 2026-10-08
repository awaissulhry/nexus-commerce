-- ONE BRAIN AB-12 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §2.4, §2.10, §5, §8 row AB-12, §10 D4 = A) — the
-- state lever: a product's brain pauses a campaign for a stop expected to last 3 days or more, resumes it when the cause
-- ends, and proposes to archive a campaign dead for weeks.
--
--   AdsBrainStateDecision  one row per campaign when its state decision changes, plus the UTC day's first for a campaign
--                          the brain paused or has a request waiting for: the cause and its horizon, the hold, the cap, what
--                          happened (shadow, asked, queued, refused …) and the brain's memory of its own pause, each with
--                          its why. Only for a campaign whose state lever is OBSERVE or higher; rows older than 30 days
--                          are deleted.
--
-- Additive only: one new business-owned table; nothing existing is modified. Nothing here writes to Amazon: the AUTO
-- level writes through the normal campaign status path (queue → write gate → gateway).
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainStateDecision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expectedEndAt" TIMESTAMP(3),
    "horizonHours" INTEGER,
    "approvalId" TEXT,
    "decisionHash" TEXT NOT NULL,
    "decision" JSONB NOT NULL,
    "why" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsBrainStateDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainStateDecision_campaignId_createdAt_idx" ON "AdsBrainStateDecision"("campaignId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainStateDecision_productId_marketplace_createdAt_idx" ON "AdsBrainStateDecision"("productId", "marketplace", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainStateDecision_marketplace_createdAt_idx" ON "AdsBrainStateDecision"("marketplace", "createdAt");

-- CreateIndex
CREATE INDEX "AdsBrainStateDecision_runId_idx" ON "AdsBrainStateDecision"("runId");

-- CreateIndex
CREATE INDEX "AdsBrainStateDecision_createdAt_idx" ON "AdsBrainStateDecision"("createdAt");

-- CreateIndex
CREATE INDEX "AdsBrainStateDecision_workspaceId_idx" ON "AdsBrainStateDecision"("workspaceId");



-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainStateDecision" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainStateDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainStateDecision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainStateDecision";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainStateDecision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainStateDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainStateDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainStateDecision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainStateDecision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
