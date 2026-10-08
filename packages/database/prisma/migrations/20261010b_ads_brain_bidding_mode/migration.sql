-- ONE BRAIN AB-17 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §2.11, §5, §8 row AB-17, §10 N4) — the
-- bidding-strategy lever: a product's brain chooses each campaign's Amazon bidding strategy (fixed, down only, up and
-- down), switches at most once per 14 days per campaign, tests every switch with a switchback test and keeps it or
-- switches back; for the first 30 days after the lever is the brain's, every switch is a request a person approves (N4).
--
--   AdsBrainStrategyDecision  one row per campaign when its decision changes, plus the UTC day's first while a test runs
--                             or a request waits: the rule, the holds, what happened, each with its why. Rows older than
--                             30 days are deleted.
--   AdsBrainStrategyTest      one row per switch the brain made or asked for outside a stop, with its switchback test (the
--                             days compared, the figures, the verdict) and the switch back. Closed rows older than 180
--                             days are deleted.
--   AdsBrainLeverClock        since when a lever of a product's brain has been the brain's (the N4 clock), one row per
--                             product × market × lever while it is.
--
-- Additive only: three new business-owned tables; nothing existing is modified. Nothing here writes to Amazon: the AUTO
-- level writes through the normal campaign path (queue → write gate → gateway).
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainStrategyDecision" (
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
    "rule" TEXT NOT NULL,
    "fromStrategy" TEXT,
    "toStrategy" TEXT,
    "approvalId" TEXT,
    "testId" TEXT,
    "decisionHash" TEXT NOT NULL,
    "decision" JSONB NOT NULL,
    "why" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsBrainStrategyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsBrainStrategyTest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "fromStrategy" TEXT NOT NULL,
    "toStrategy" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvalId" TEXT,
    "switchedAt" TIMESTAMP(3),
    "actionLogId" TEXT,
    "baselineFrom" DATE,
    "baselineTo" DATE,
    "testFrom" DATE,
    "testTo" DATE,
    "verdict" TEXT,
    "verdictAt" TIMESTAMP(3),
    "figures" JSONB,
    "revertApprovalId" TEXT,
    "revertedAt" TIMESTAMP(3),
    "revertActionLogId" TEXT,
    "why" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainStrategyTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsBrainLeverClock" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "lever" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "by" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainLeverClock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainStrategyDecision_campaignId_createdAt_idx" ON "AdsBrainStrategyDecision"("campaignId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainStrategyDecision_productId_marketplace_createdAt_idx" ON "AdsBrainStrategyDecision"("productId", "marketplace", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainStrategyDecision_marketplace_createdAt_idx" ON "AdsBrainStrategyDecision"("marketplace", "createdAt");

-- CreateIndex
CREATE INDEX "AdsBrainStrategyDecision_runId_idx" ON "AdsBrainStrategyDecision"("runId");

-- CreateIndex
CREATE INDEX "AdsBrainStrategyDecision_createdAt_idx" ON "AdsBrainStrategyDecision"("createdAt");

-- CreateIndex
CREATE INDEX "AdsBrainStrategyDecision_workspaceId_idx" ON "AdsBrainStrategyDecision"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsBrainStrategyTest_campaignId_createdAt_idx" ON "AdsBrainStrategyTest"("campaignId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainStrategyTest_productId_marketplace_status_idx" ON "AdsBrainStrategyTest"("productId", "marketplace", "status");

-- CreateIndex
CREATE INDEX "AdsBrainStrategyTest_status_idx" ON "AdsBrainStrategyTest"("status");

-- CreateIndex
CREATE INDEX "AdsBrainStrategyTest_createdAt_idx" ON "AdsBrainStrategyTest"("createdAt");

-- CreateIndex
CREATE INDEX "AdsBrainStrategyTest_workspaceId_idx" ON "AdsBrainStrategyTest"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsBrainLeverClock_workspaceId_idx" ON "AdsBrainLeverClock"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainLeverClock_workspaceId_productId_marketplace_lever_key" ON "AdsBrainLeverClock"("workspaceId", "productId", "marketplace", "lever");


-- ── (2) Row-level security for AdsBrainStrategyDecision ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainStrategyDecision" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainStrategyDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainStrategyDecision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainStrategyDecision";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainStrategyDecision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainStrategyDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainStrategyDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainStrategyDecision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainStrategyDecision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for AdsBrainStrategyTest ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainStrategyTest" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainStrategyTest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainStrategyTest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainStrategyTest";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainStrategyTest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainStrategyTest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainStrategyTest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainStrategyTest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainStrategyTest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for AdsBrainLeverClock ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainLeverClock" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainLeverClock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainLeverClock" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainLeverClock";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainLeverClock" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainLeverClock"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainLeverClock"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainLeverClock";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainLeverClock" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
