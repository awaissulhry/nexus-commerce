-- Negative Targeting page (2026-10-11, lane NWRITE) — the "kept paused" lock and Skip.
--
--   AdTarget.keptPausedAt / keptPausedBy / keptPausedUntil / keptPausedReason
--                 a keyword or product target kept paused: while it holds, no automatic writer (a rule, the brain, an
--                 engine, Claude by rule, a playbook sync, a bulk-sheet rollback) may switch it back on; only a person with
--                 an explicit release (ads-mutation.service.ts updateAdTargetWithSync, waste/hold.ts). All null = not held.
--   AdTarget.negativeOrigin
--                 who made a negative (HARVEST | BRAIN_FUNNEL | BRAIN | PLAYBOOK | RULE | CLAUDE | PERSON), stored by the one
--                 negative write door; null = not known (earlier rows, rows Amazon's sync brought in).
--   AdsWasteSkip  a waste row a person snoozed for 7 or 30 days (Nexus only).
--
-- Additive only: five nullable columns and one new business-owned table; nothing existing is modified, so every current
-- screen and job behaves exactly as before (no row is held, no origin is set, nothing is skipped).
--
-- Order: (1) what Prisma derives from schema.prisma; (2) row-level security for the new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets
-- (20260923a pattern).

-- AlterTable
ALTER TABLE "AdTarget" ADD COLUMN     "keptPausedAt" TIMESTAMP(3),
ADD COLUMN     "keptPausedBy" TEXT,
ADD COLUMN     "keptPausedReason" TEXT,
ADD COLUMN     "keptPausedUntil" TIMESTAMP(3),
ADD COLUMN     "negativeOrigin" TEXT;

-- CreateTable
CREATE TABLE "AdsWasteSkip" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "by" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,

    CONSTRAINT "AdsWasteSkip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsWasteSkip_rowKey_endedAt_idx" ON "AdsWasteSkip"("rowKey", "endedAt");

-- CreateIndex
CREATE INDEX "AdsWasteSkip_until_idx" ON "AdsWasteSkip"("until");

-- CreateIndex
CREATE INDEX "AdsWasteSkip_workspaceId_idx" ON "AdsWasteSkip"("workspaceId");


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsWasteSkip" TO nexus_workspace_runtime;
ALTER TABLE "AdsWasteSkip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsWasteSkip" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsWasteSkip";
CREATE POLICY nexus_workspace_isolation ON "AdsWasteSkip" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsWasteSkip"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsWasteSkip"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsWasteSkip";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsWasteSkip" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
