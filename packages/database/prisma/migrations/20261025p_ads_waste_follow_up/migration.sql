-- Negative Targeting step 4 (2026-10-25) — "Remove protection and stop" finishes on the server.
--
--   AdsWasteFollowUp  the negatives that wait for a protected term's removal (their tool refuses a protected term): sent
--                     by the server once the removal ran, as the person who approved it, through the page's own write
--                     (apps/api/src/services/advertising/waste/follow-up.ts). One per removal change set.
--
-- Additive only: one new business-owned table; nothing existing is modified.
--
-- Order: (1) what Prisma derives from schema.prisma; (2) row-level security for the new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsWasteFollowUp" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "rowIds" TEXT[],
    "by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "changeSetId" TEXT,
    "results" JSONB,
    "why" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AdsWasteFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsWasteFollowUp_approvalId_idx" ON "AdsWasteFollowUp"("approvalId");

-- CreateIndex
CREATE INDEX "AdsWasteFollowUp_status_createdAt_idx" ON "AdsWasteFollowUp"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdsWasteFollowUp_workspaceId_idx" ON "AdsWasteFollowUp"("workspaceId");

-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsWasteFollowUp" TO nexus_workspace_runtime;
ALTER TABLE "AdsWasteFollowUp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsWasteFollowUp" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsWasteFollowUp";
CREATE POLICY nexus_workspace_isolation ON "AdsWasteFollowUp" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsWasteFollowUp"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsWasteFollowUp"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsWasteFollowUp";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsWasteFollowUp" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
