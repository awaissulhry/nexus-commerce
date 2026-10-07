-- Amazon fulfilment conversion (Owner 2026-10-07) — FulfilmentConversion: one row per listing and Amazon marketplace an
-- FBA ⇄ FBM change was sent to, with Amazon's answer and what its merchant listings report confirmed afterwards.
-- Additive only: one new business-owned table (and its back-relation on ChannelListing, which adds no column); nothing
-- existing is modified, and with no rows every current screen and job behaves exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the 20260923a pattern).

-- CreateTable
CREATE TABLE "FulfilmentConversion" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "channelConnectionId" TEXT,
    "sku" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "fromMethod" TEXT NOT NULL,
    "toMethod" TEXT NOT NULL,
    "quantity" INTEGER,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "message" TEXT,
    "submissionId" TEXT,
    "submissionStatus" TEXT,
    "issues" JSONB,
    "operatorConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reportChannel" TEXT,
    "reportPulls" INTEGER NOT NULL DEFAULT 0,
    "lastReportAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfilmentConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FulfilmentConversion_workspaceId_idx" ON "FulfilmentConversion"("workspaceId");

-- CreateIndex
CREATE INDEX "FulfilmentConversion_channelListingId_createdAt_idx" ON "FulfilmentConversion"("channelListingId", "createdAt");

-- CreateIndex
CREATE INDEX "FulfilmentConversion_status_createdAt_idx" ON "FulfilmentConversion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FulfilmentConversion_sku_marketplaceId_idx" ON "FulfilmentConversion"("sku", "marketplaceId");

-- AddForeignKey
ALTER TABLE "FulfilmentConversion" ADD CONSTRAINT "FulfilmentConversion_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "FulfilmentConversion" TO nexus_workspace_runtime;
ALTER TABLE "FulfilmentConversion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FulfilmentConversion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "FulfilmentConversion";
CREATE POLICY nexus_workspace_isolation ON "FulfilmentConversion" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FulfilmentConversion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "FulfilmentConversion"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "FulfilmentConversion";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "FulfilmentConversion" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
