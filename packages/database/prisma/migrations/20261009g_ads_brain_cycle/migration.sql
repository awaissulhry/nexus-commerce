-- ONE BRAIN AB-14 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §4, §5, §6, §8 row AB-14) — the product cycle:
-- one product × market on one settled data day, its levers run in the design's order (stops and state, the term ledger,
-- negatives, harvest, money, bids, hours), one change set carried in the evidence of every write it makes, and the day's
-- product report.
--
--   AdsBrainCycle  one row per product × market × data day: the change set id, each step's outcome (done, off, skipped,
--                  blocked, failed) with its why, the attempts and the lease, and the day's report (what each lever did
--                  or would do in shadow, ad sales against spend, what waits for the Owner, clashes, his locks).
--
-- Additive only: one new business-owned table; nothing existing is modified. The cycle is off unless
-- NEXUS_ADS_BRAIN_CYCLE=on, so with this release no row is ever written and every lever's own cron runs as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainCycle" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "dataDay" DATE NOT NULL,
    "changeSetId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "steps" JSONB NOT NULL,
    "report" JSONB,
    "summary" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainCycle_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "AdsBrainCycle_productId_marketplace_dataDay_idx" ON "AdsBrainCycle"("productId", "marketplace", "dataDay" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainCycle_marketplace_dataDay_idx" ON "AdsBrainCycle"("marketplace", "dataDay" DESC);

-- CreateIndex
CREATE INDEX "AdsBrainCycle_createdAt_idx" ON "AdsBrainCycle"("createdAt");

-- CreateIndex
CREATE INDEX "AdsBrainCycle_workspaceId_idx" ON "AdsBrainCycle"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainCycle_workspaceId_productId_marketplace_dataDay_key" ON "AdsBrainCycle"("workspaceId", "productId", "marketplace", "dataDay");



-- ── (2) Row-level security for AdsBrainCycle ─────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainCycle" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainCycle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainCycle" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainCycle";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainCycle" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainCycle"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainCycle"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainCycle";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainCycle" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
