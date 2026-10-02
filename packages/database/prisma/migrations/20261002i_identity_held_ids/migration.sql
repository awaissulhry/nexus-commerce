-- MCP full control I6 (docs/mcp-full-control/sections/04-identity.md §4.2 M1) — ChannelHeldId: the ids each channel
-- account holds, as its own read says; ChannelHeldSweep: the last sweep of each account. Additive only: two new
-- business-owned tables; nothing existing is modified, and with no rows every current screen and job behaves exactly as
-- before (the sweep that fills them is off until NEXUS_IDENTITY_SWEEP=1).
--
-- Order: (1) the tables Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the 20260923a
-- pattern).

-- CreateTable
CREATE TABLE "ChannelHeldId" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "sellerSku" TEXT NOT NULL DEFAULT '',
    "title" TEXT,
    "remoteStatus" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "listingId" TEXT,
    "matchState" TEXT NOT NULL DEFAULT 'UNLINKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelHeldId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelHeldSweep" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "itemsSeen" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "lastCompleteAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelHeldSweep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelHeldId_workspaceId_idx" ON "ChannelHeldId"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelHeldId_channelConnectionId_endedAt_idx" ON "ChannelHeldId"("channelConnectionId", "endedAt");

-- CreateIndex
CREATE INDEX "ChannelHeldId_listingId_idx" ON "ChannelHeldId"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelHeldId_workspaceId_channelConnectionId_marketplace_e_key" ON "ChannelHeldId"("workspaceId", "channelConnectionId", "marketplace", "externalId", "sellerSku");

-- CreateIndex
CREATE INDEX "ChannelHeldSweep_workspaceId_idx" ON "ChannelHeldSweep"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelHeldSweep_workspaceId_channelConnectionId_channel_key" ON "ChannelHeldSweep"("workspaceId", "channelConnectionId", "channel");

-- AddForeignKey
ALTER TABLE "ChannelHeldId" ADD CONSTRAINT "ChannelHeldId_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelHeldId" ADD CONSTRAINT "ChannelHeldId_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ChannelListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelHeldSweep" ADD CONSTRAINT "ChannelHeldSweep_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for the business-owned tables ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelHeldId" TO nexus_workspace_runtime;
ALTER TABLE "ChannelHeldId" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelHeldId" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelHeldId";
CREATE POLICY nexus_workspace_isolation ON "ChannelHeldId" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelHeldId"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelHeldId"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelHeldId";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelHeldId" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"channelConnectionId","to":"id"},{"model":"ChannelListing","from":"listingId","to":"id"}]');
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelHeldSweep" TO nexus_workspace_runtime;
ALTER TABLE "ChannelHeldSweep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelHeldSweep" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelHeldSweep";
CREATE POLICY nexus_workspace_isolation ON "ChannelHeldSweep" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelHeldSweep"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelHeldSweep"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelHeldSweep";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelHeldSweep" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
