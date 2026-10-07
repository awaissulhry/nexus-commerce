-- ADS AUTONOMY — auto-undo (automation A19): AdsAutoUndoJudgement, one row per automatic Amazon ad change auto-undo
-- judged (an engine's, a rule's at AUTO, or a Claude change that ran by the business's rule), with the shared watch-week
-- outcome, the numbers it stands on and what auto-undo did (nothing, would undo, asked a person, undid it, or held it).
-- Additive only: one new business-owned table; nothing existing is modified. Auto-undo is born OBSERVE (it records, it
-- changes nothing at Amazon), so with no rows every current screen and job behaves exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the AE.2 pattern,
-- 20260916g).

-- CreateTable
CREATE TABLE "AdsAutoUndoJudgement" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "actionLogId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "originLabel" TEXT,
    "approvalId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "marketplace" TEXT,
    "lever" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "fromValue" DOUBLE PRECISION,
    "toValue" DOUBLE PRECISION,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "verdict" TEXT NOT NULL,
    "outcome" TEXT,
    "evidence" JSONB,
    "action" TEXT NOT NULL DEFAULT 'none',
    "actionReason" TEXT,
    "actionAt" TIMESTAMP(3),
    "level" TEXT NOT NULL,
    "undoApprovalId" TEXT,
    "undoActionLogId" TEXT,
    "final" BOOLEAN NOT NULL DEFAULT false,
    "judgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsAutoUndoJudgement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsAutoUndoJudgement_workspaceId_idx" ON "AdsAutoUndoJudgement"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsAutoUndoJudgement_final_checkedAt_idx" ON "AdsAutoUndoJudgement"("final", "checkedAt");

-- CreateIndex
CREATE INDEX "AdsAutoUndoJudgement_action_actionAt_idx" ON "AdsAutoUndoJudgement"("action", "actionAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdsAutoUndoJudgement_workspace_actionLogId_key" ON "AdsAutoUndoJudgement"("workspaceId", "actionLogId");



-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsAutoUndoJudgement" TO nexus_workspace_runtime;
ALTER TABLE "AdsAutoUndoJudgement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsAutoUndoJudgement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsAutoUndoJudgement";
CREATE POLICY nexus_workspace_isolation ON "AdsAutoUndoJudgement" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsAutoUndoJudgement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsAutoUndoJudgement"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsAutoUndoJudgement";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsAutoUndoJudgement" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
