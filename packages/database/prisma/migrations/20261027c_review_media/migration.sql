-- Reviews eBay REST (2026-10-27, Reviews area rebuild PR G) — what eBay's REST Feedback API gives that the Trading
-- call did not, and the feedback the seller still owes buyers.
--
--   Review               + channelTopics (eBay's AI topics, JSON), feedbackState (eBay's state of the feedback, e.g.
--                          REVISION_OPEN while a revision request waits for the buyer), revisionEligible (eBay's
--                          eligibleForRevision) and feedbackStateAt (when Nexus first read that state). All nullable.
--   ReviewMedia          the photos/videos a buyer added (eBay: up to 5 per feedback), one row each, eBay's link kept.
--   EbayBuyerFeedback    eBay order lines waiting for the seller's feedback for the buyer (getItemsAwaitingFeedback),
--                        and what was left from Nexus after a person approved it.
--
-- Additive only: nullable columns and two new business-owned tables; nothing existing is changed or dropped. With no
-- rows and the columns null, every current screen and job behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma (prisma migrate diff, schema to schema, offline); (2) row-level
-- security for each new table, emitted by workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern),
-- after its runtime-role grant.
--
-- Rollback: DROP TABLE "EbayBuyerFeedback"; DROP TABLE "ReviewMedia";
--           ALTER TABLE "Review" DROP COLUMN "channelTopics", DROP COLUMN "feedbackState", DROP COLUMN "feedbackStateAt",
--           DROP COLUMN "revisionEligible";

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "channelTopics" JSONB,
ADD COLUMN     "feedbackState" TEXT,
ADD COLUMN     "feedbackStateAt" TIMESTAMP(3),
ADD COLUMN     "revisionEligible" BOOLEAN;

-- CreateTable
CREATE TABLE "ReviewMedia" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'image',
    "width" INTEGER,
    "height" INTEGER,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayBuyerFeedback" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "orderLineItemId" TEXT NOT NULL,
    "listingId" TEXT,
    "transactionId" TEXT,
    "title" TEXT,
    "price" DECIMAL(12,2),
    "currency" TEXT,
    "orderId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'AWAITING',
    "approvalId" TEXT,
    "commentText" TEXT,
    "feedbackId" TEXT,
    "leftBy" TEXT,
    "leftAt" TIMESTAMP(3),
    "lastWords" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayBuyerFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewMedia_reviewId_idx" ON "ReviewMedia"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewMedia_workspaceId_idx" ON "ReviewMedia"("workspaceId");

-- CreateIndex
CREATE INDEX "EbayBuyerFeedback_state_idx" ON "EbayBuyerFeedback"("state");

-- CreateIndex
CREATE INDEX "EbayBuyerFeedback_workspaceId_idx" ON "EbayBuyerFeedback"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayBuyerFeedback_connectionId_orderLineItemId_key" ON "EbayBuyerFeedback"("workspaceId", "connectionId", "orderLineItemId");

-- AddForeignKey
ALTER TABLE "ReviewMedia" ADD CONSTRAINT "ReviewMedia_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── (2) Row-level security for ReviewMedia ────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewMedia" TO nexus_workspace_runtime;
ALTER TABLE "ReviewMedia" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewMedia" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewMedia";
CREATE POLICY nexus_workspace_isolation ON "ReviewMedia" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewMedia"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewMedia"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewMedia";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewMedia" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Review","from":"reviewId","to":"id"}]');

-- ── (2) Row-level security for EbayBuyerFeedback ──────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "EbayBuyerFeedback" TO nexus_workspace_runtime;
ALTER TABLE "EbayBuyerFeedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayBuyerFeedback" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "EbayBuyerFeedback";
CREATE POLICY nexus_workspace_isolation ON "EbayBuyerFeedback" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayBuyerFeedback"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "EbayBuyerFeedback"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "EbayBuyerFeedback";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "EbayBuyerFeedback" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
