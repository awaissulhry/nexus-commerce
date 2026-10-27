-- Reviews timing tests (2026-10-27, Reviews area rebuild PR J) — timing tests and the A/B split of review requests.
--
--   ReviewTimingTest       one test: TIMING (new orders of one market, and product type when set, split by order number
--                          into groups first asked on different days; a holdout group is not asked at all) or AB (the
--                          orders rule A decides, split between A and its "Duplicate as A/B" copy B). Status DRAFT →
--                          WAITING_APPROVAL → RUNNING (only after a person approved "Start test") → STOPPED | DONE.
--   ReviewTimingTestArm    one group of a test: a first-try day, a rule, or the holdout; the counts last read.
--   ReviewRequest          + timingTestArmId (nullable): the group the scheduler put the order in while a test ran.
--
-- Additive only: a nullable column and two new business-owned tables; nothing existing is changed or dropped. With no
-- test rows, the scheduler and every screen behave exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma (prisma migrate diff, schema to schema, offline); (2) row-level
-- security for each new table, emitted by workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern),
-- after its runtime-role grant.
--
-- Rollback: DROP TABLE "ReviewTimingTestArm"; DROP TABLE "ReviewTimingTest";
--           ALTER TABLE "ReviewRequest" DROP COLUMN "timingTestArmId";

-- AlterTable
ALTER TABLE "ReviewRequest" ADD COLUMN     "timingTestArmId" TEXT;

-- CreateTable
CREATE TABLE "ReviewTimingTest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TIMING',
    "channel" TEXT NOT NULL DEFAULT 'AMAZON',
    "market" TEXT NOT NULL,
    "productType" TEXT,
    "ruleId" TEXT,
    "holdoutPct" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalId" TEXT,
    "lastWords" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endsWhen" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "createdBy" TEXT,
    "stoppedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewTimingTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewTimingTestArm" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "delayDays" INTEGER,
    "ruleId" TEXT,
    "holdout" BOOLEAN NOT NULL DEFAULT false,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "reviews" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewTimingTestArm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewTimingTest_status_idx" ON "ReviewTimingTest"("status");

-- CreateIndex
CREATE INDEX "ReviewTimingTest_workspaceId_idx" ON "ReviewTimingTest"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewTimingTestArm_testId_idx" ON "ReviewTimingTestArm"("testId");

-- CreateIndex
CREATE INDEX "ReviewTimingTestArm_workspaceId_idx" ON "ReviewTimingTestArm"("workspaceId");

-- CreateIndex
CREATE INDEX "ReviewRequest_timingTestArmId_idx" ON "ReviewRequest"("timingTestArmId");

-- AddForeignKey
ALTER TABLE "ReviewTimingTestArm" ADD CONSTRAINT "ReviewTimingTestArm_testId_fkey" FOREIGN KEY ("testId") REFERENCES "ReviewTimingTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── (2) Row-level security for ReviewTimingTest ────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewTimingTest" TO nexus_workspace_runtime;
ALTER TABLE "ReviewTimingTest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewTimingTest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewTimingTest";
CREATE POLICY nexus_workspace_isolation ON "ReviewTimingTest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewTimingTest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewTimingTest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewTimingTest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewTimingTest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');

-- ── (2) Row-level security for ReviewTimingTestArm ─────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewTimingTestArm" TO nexus_workspace_runtime;
ALTER TABLE "ReviewTimingTestArm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewTimingTestArm" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewTimingTestArm";
CREATE POLICY nexus_workspace_isolation ON "ReviewTimingTestArm" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewTimingTestArm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewTimingTestArm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewTimingTestArm";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewTimingTestArm" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ReviewTimingTest","from":"testId","to":"id"}]');
