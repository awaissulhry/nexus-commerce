-- BID BRAIN BB-2 — the bid brain's four tables (design BID-BRAIN-DESIGN.md §5–§6, Owner decisions 2026-10-07).
-- Additive only: four new business-owned tables; nothing existing is modified, and with no rows every current
-- screen, engine and job behaves exactly as before. Nothing writes to Amazon from these tables before BB-6.
--
--   BidBrainEnrollment  a campaign's mode under NEXUS_BID_BRAIN_MODE (SHADOW | LIVE | HELD) and its join snapshot
--   BidBrainDecision    one decision per keyword with its why (shadow: what it would set vs what writers set)
--   BidHold             a pin / person / Claude / auto-undo hold with an end date
--   BidDirective        a rule's bid action as an input (ceiling, floor, goal, share floor)
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the AE.2 pattern).


-- CreateTable
CREATE TABLE "BidBrainEnrollment" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'SHADOW',
    "heldUntil" TIMESTAMP(3),
    "heldBy" TEXT,
    "heldReason" TEXT,
    "snapshot" JSONB,
    "enrolledBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BidBrainEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BidBrainDecision" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "targetId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "currentCents" INTEGER NOT NULL,
    "decidedCents" INTEGER NOT NULL,
    "goalBidCents" INTEGER,
    "aim" DECIMAL(8,4),
    "bandLo" DECIMAL(8,4),
    "bandHi" DECIMAL(8,4),
    "expectedAcos" DECIMAL(10,4),
    "confidence" DECIMAL(6,4),
    "dataDay" DATE NOT NULL,
    "lastWriter" TEXT,
    "lastWriteAt" TIMESTAMP(3),
    "why" TEXT NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BidBrainDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BidHold" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "targetId" TEXT,
    "kind" TEXT NOT NULL,
    "until" TIMESTAMP(3),
    "by" TEXT NOT NULL,
    "reason" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BidHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BidDirective" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "targetId" TEXT,
    "lane" TEXT,
    "kind" TEXT NOT NULL,
    "valueCents" INTEGER,
    "valuePct" INTEGER,
    "source" TEXT NOT NULL,
    "until" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BidDirective_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BidBrainEnrollment_mode_idx" ON "BidBrainEnrollment"("mode");

-- CreateIndex
CREATE INDEX "BidBrainEnrollment_workspaceId_idx" ON "BidBrainEnrollment"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BidBrainEnrollment_workspaceId_campaignId_key" ON "BidBrainEnrollment"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "BidBrainDecision_campaignId_createdAt_idx" ON "BidBrainDecision"("campaignId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BidBrainDecision_targetId_createdAt_idx" ON "BidBrainDecision"("targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BidBrainDecision_runId_idx" ON "BidBrainDecision"("runId");

-- CreateIndex
CREATE INDEX "BidBrainDecision_createdAt_idx" ON "BidBrainDecision"("createdAt");

-- CreateIndex
CREATE INDEX "BidBrainDecision_workspaceId_idx" ON "BidBrainDecision"("workspaceId");

-- CreateIndex
CREATE INDEX "BidHold_campaignId_endedAt_idx" ON "BidHold"("campaignId", "endedAt");

-- CreateIndex
CREATE INDEX "BidHold_targetId_idx" ON "BidHold"("targetId");

-- CreateIndex
CREATE INDEX "BidHold_workspaceId_idx" ON "BidHold"("workspaceId");

-- CreateIndex
CREATE INDEX "BidDirective_campaignId_idx" ON "BidDirective"("campaignId");

-- CreateIndex
CREATE INDEX "BidDirective_targetId_idx" ON "BidDirective"("targetId");

-- CreateIndex
CREATE INDEX "BidDirective_workspaceId_idx" ON "BidDirective"("workspaceId");


-- ── (2) Row-level security for the business-owned tables ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BidBrainEnrollment" TO nexus_workspace_runtime;
ALTER TABLE "BidBrainEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BidBrainEnrollment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BidBrainEnrollment";
CREATE POLICY nexus_workspace_isolation ON "BidBrainEnrollment" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidBrainEnrollment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidBrainEnrollment"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BidBrainEnrollment";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BidBrainEnrollment" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BidBrainDecision" TO nexus_workspace_runtime;
ALTER TABLE "BidBrainDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BidBrainDecision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BidBrainDecision";
CREATE POLICY nexus_workspace_isolation ON "BidBrainDecision" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidBrainDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidBrainDecision"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BidBrainDecision";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BidBrainDecision" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BidHold" TO nexus_workspace_runtime;
ALTER TABLE "BidHold" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BidHold" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BidHold";
CREATE POLICY nexus_workspace_isolation ON "BidHold" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidHold"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidHold"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BidHold";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BidHold" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BidDirective" TO nexus_workspace_runtime;
ALTER TABLE "BidDirective" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BidDirective" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BidDirective";
CREATE POLICY nexus_workspace_isolation ON "BidDirective" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidDirective"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BidDirective"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BidDirective";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BidDirective" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
