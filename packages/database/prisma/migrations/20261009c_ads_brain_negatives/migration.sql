-- ONE BRAIN AB-10 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §2.7, §4, §5, §8 row AB-10) — the negatives log.
--
--   AdsBrainNegative  one row per negative a product's brain would add or retire in one market — where (campaign or ad
--                     group), what (exact, phrase, product target), why (the product's set, waste, n-gram, isolation,
--                     consolidation, a duplicate, a revive), at which level — and what became of it: SHADOW, HELD,
--                     PLANNED, PROPOSED, REJECTED, WRITTEN, QUEUED, REFUSED or FAILED. The unique key (business, product,
--                     market, key) makes two rows for one negative impossible.
--
-- Written only by the daily negatives run (services/advertising/brain/negatives-run.ts) for products whose negatives
-- lever is OBSERVE or higher. Rows no run checked for 30 days are deleted.
--
-- Additive only: one new business-owned table; nothing existing is modified. With no product enrolled (production
-- today) the run reads the enrollments only and writes nothing.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainNegative" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "reasons" TEXT[],
    "kind" TEXT NOT NULL,
    "match" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adGroupId" TEXT,
    "negativeId" TEXT,
    "origin" TEXT,
    "coverId" TEXT,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "askFirst" BOOLEAN NOT NULL DEFAULT false,
    "heldBy" TEXT,
    "why" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "approvalId" TEXT,
    "adTargetId" TEXT,
    "outboundQueueId" TEXT,
    "result" TEXT,
    "digest" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "dataDay" DATE NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainNegative_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainNegative_productId_marketplace_runId_idx" ON "AdsBrainNegative"("productId", "marketplace", "runId");

-- CreateIndex
CREATE INDEX "AdsBrainNegative_productId_marketplace_actedAt_idx" ON "AdsBrainNegative"("productId", "marketplace", "actedAt");

-- CreateIndex
CREATE INDEX "AdsBrainNegative_approvalId_idx" ON "AdsBrainNegative"("approvalId");

-- CreateIndex
CREATE INDEX "AdsBrainNegative_checkedAt_idx" ON "AdsBrainNegative"("checkedAt");

-- CreateIndex
CREATE INDEX "AdsBrainNegative_workspaceId_idx" ON "AdsBrainNegative"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainNegative_workspaceId_productId_marketplace_key_key" ON "AdsBrainNegative"("workspaceId", "productId", "marketplace", "key");



-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainNegative" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainNegative" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainNegative" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainNegative";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainNegative" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainNegative"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainNegative"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainNegative";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainNegative" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
