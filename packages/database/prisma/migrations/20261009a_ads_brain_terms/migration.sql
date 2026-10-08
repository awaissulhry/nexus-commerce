-- ONE BRAIN AB-9 (2026-10-08, design 2026-10-08-ads-one-brain/DESIGN.md §1, §2.7, §2.8, §4, §8 row AB-9) — the term ledger
-- and the market arbiter, in SHADOW.
--
--   AdsBrainTerm      one decision per term of one product (family root) in one market: TARGETED, HARVEST_CANDIDATE,
--                     OWNED_BY_SIBLING, PROTECTED, NEGATED, NEGATE_CANDIDATE or WATCH, with its evidence. The unique key
--                     (business, product, market, term) makes a second decision on one term impossible.
--   AdsBrainTermLead  the arbiter's lead on one term sibling products meet on in one market (the others bid at most
--                     0.8 × the lead's bid and never harvest it).
--
-- Written only by the daily shadow run (services/advertising/brain/terms-shadow.ts) for products whose negatives or
-- harvest lever is OBSERVE or higher; nothing here writes to Amazon. Rows no run checked for 30 days are deleted.
--
-- Additive only: two new business-owned tables; nothing existing is modified. With no product enrolled (production
-- today) the run reads the enrollments only and writes nothing.
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (20260923a pattern).

-- CreateTable
CREATE TABLE "AdsBrainTerm" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "isAsin" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL,
    "previousState" TEXT,
    "stateSince" TIMESTAMP(3) NOT NULL,
    "protection" TEXT,
    "leadProductId" TEXT,
    "heldBy" TEXT,
    "capped" BOOLEAN NOT NULL DEFAULT false,
    "askFirst" BOOLEAN NOT NULL DEFAULT false,
    "clashCount" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "windowDays" INTEGER NOT NULL,
    "dataDay" DATE NOT NULL,
    "why" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsBrainTermLead" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "leadProductId" TEXT NOT NULL,
    "previousLeadProductId" TEXT,
    "leadSince" TIMESTAMP(3) NOT NULL,
    "rule" TEXT NOT NULL,
    "leadBidCents" INTEGER,
    "maxBidCents" INTEGER,
    "contenders" JSONB NOT NULL,
    "wouldLower" JSONB NOT NULL,
    "why" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsBrainTermLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsBrainTerm_marketplace_term_idx" ON "AdsBrainTerm"("marketplace", "term");

-- CreateIndex
CREATE INDEX "AdsBrainTerm_productId_marketplace_state_idx" ON "AdsBrainTerm"("productId", "marketplace", "state");

-- CreateIndex
CREATE INDEX "AdsBrainTerm_checkedAt_idx" ON "AdsBrainTerm"("checkedAt");

-- CreateIndex
CREATE INDEX "AdsBrainTerm_workspaceId_idx" ON "AdsBrainTerm"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainTerm_workspaceId_productId_marketplace_term_key" ON "AdsBrainTerm"("workspaceId", "productId", "marketplace", "term");

-- CreateIndex
CREATE INDEX "AdsBrainTermLead_leadProductId_idx" ON "AdsBrainTermLead"("leadProductId");

-- CreateIndex
CREATE INDEX "AdsBrainTermLead_checkedAt_idx" ON "AdsBrainTermLead"("checkedAt");

-- CreateIndex
CREATE INDEX "AdsBrainTermLead_workspaceId_idx" ON "AdsBrainTermLead"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsBrainTermLead_workspaceId_marketplace_term_key" ON "AdsBrainTermLead"("workspaceId", "marketplace", "term");



-- ── (2) Row-level security for the business-owned tables ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainTerm" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainTerm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainTerm" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainTerm";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainTerm" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainTerm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainTerm"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainTerm";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainTerm" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdsBrainTermLead" TO nexus_workspace_runtime;
ALTER TABLE "AdsBrainTermLead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdsBrainTermLead" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AdsBrainTermLead";
CREATE POLICY nexus_workspace_isolation ON "AdsBrainTermLead" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainTermLead"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AdsBrainTermLead"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "AdsBrainTermLead";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "AdsBrainTermLead" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
