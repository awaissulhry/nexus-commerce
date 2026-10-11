-- HARVEST ENGINE (2026-10-10, Keyword Harvest page rebuild, lane HCORE; services/advertising/harvest/) — ONE harvest record
-- for every actor and the Sources view's pause.
--
--   AdsBrainHarvest        gains who harvested (actorKind BRAIN | PERSON | CLAUDE | RULE, actorId), the change set it went
--                          out in (changeSetId: the one apply-harvest approval), the keyword's match type (EXACT | PHRASE),
--                          the funnel blocks that came with it, the new campaign / portfolio it is built into and the stage
--                          an executing change set stands at, and a person's skip (until a date, or for good). Every new
--                          column is nullable or has a default: the brain's rows keep reading as before (actorKind BRAIN,
--                          match EXACT, no funnel, no skip).
--   AdsHarvestSourcePause  one row per source ad group a person paused harvesting from (business-owned, row-level security).
--
-- Additive only: nothing existing is changed or dropped. Nothing is written by this release until a person (or Claude, by
-- approval) harvests, skips or pauses a source; the brain's own harvests keep their behaviour.
--
-- Order: (1) the DDL Prisma derives from schema.prisma; (2) row-level security for the new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern).

-- AlterTable
ALTER TABLE "AdsBrainHarvest" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "actorKind" TEXT NOT NULL DEFAULT 'BRAIN',
ADD COLUMN     "changeSetId" TEXT,
ADD COLUMN     "funnel" JSONB,
ADD COLUMN     "match" TEXT NOT NULL DEFAULT 'EXACT',
ADD COLUMN     "newCampaign" JSONB,
ADD COLUMN     "skippedAt" TIMESTAMP(3),
ADD COLUMN     "skippedBy" TEXT,
ADD COLUMN     "skippedForGood" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "skippedUntil" TIMESTAMP(3),
ADD COLUMN     "stage" TEXT;

-- CreateTable
CREATE TABLE "AdsHarvestSourcePause" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "pausedBy" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsHarvestSourcePause_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsHarvestSourcePause_workspaceId_idx" ON "AdsHarvestSourcePause"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsHarvestSourcePause_workspaceId_adGroupId_key" ON "AdsHarvestSourcePause"("workspaceId", "adGroupId");

-- CreateIndex
CREATE INDEX "AdsBrainHarvest_changeSetId_idx" ON "AdsBrainHarvest"("changeSetId");


-- ── (2) Row-level security for AdsHarvestSourcePause ─────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsHarvestSourcePause" TO nexus_workspace_runtime;
ALTER TABLE "AdsHarvestSourcePause" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsHarvestSourcePause" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsHarvestSourcePause";
CREATE POLICY nexus_workspace_isolation ON "AdsHarvestSourcePause" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsHarvestSourcePause"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsHarvestSourcePause"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsHarvestSourcePause";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsHarvestSourcePause" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
