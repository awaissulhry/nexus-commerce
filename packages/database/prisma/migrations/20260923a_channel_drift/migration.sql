-- PLAN Step 3.5a (A-36, R-36) — ChannelDrift: what a channel holds that differs from what Nexus holds, per listing.
-- Additive only: one new business-owned table; nothing existing is modified, and with no rows every current screen and
-- job behaves exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the AE.2 pattern,
-- 20260916g).

-- CreateTable
CREATE TABLE "ChannelDrift" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "channelListingId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "driftedFields" JSONB NOT NULL DEFAULT '[]',
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelDrift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelDrift_workspaceId_idx" ON "ChannelDrift"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelDrift_driftCount_idx" ON "ChannelDrift"("driftCount");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelDrift_workspaceId_channelListingId_key" ON "ChannelDrift"("workspaceId", "channelListingId");

-- AddForeignKey
ALTER TABLE "ChannelDrift" ADD CONSTRAINT "ChannelDrift_channelListingId_fkey" FOREIGN KEY ("channelListingId") REFERENCES "ChannelListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelDrift" TO nexus_workspace_runtime;
ALTER TABLE "ChannelDrift" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelDrift" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelDrift";
CREATE POLICY nexus_workspace_isolation ON "ChannelDrift" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelDrift"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelDrift"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ChannelDrift";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ChannelDrift" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelListing","from":"channelListingId","to":"id"}]');
