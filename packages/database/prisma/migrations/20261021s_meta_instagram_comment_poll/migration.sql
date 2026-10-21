-- META ADS step 37 (2026-10-21) — the Instagram comment poll. Instagram sends no comment webhook without Advanced
-- access, so Nexus reads the newest media of each business's chosen Instagram account every 15 minutes and tells the
-- business of new comments (a notification; the person reads and answers them live with meta-comments / set-meta-comments).
--
--   MetaInstagramCommentPoll   one row per media of the newest 25 the poll reads: Meta's comment count, the newest comment
--                              time seen, when it was last read. NO comment text, username or user id is ever stored.
--
-- Additive only: one new business-owned table; nothing existing is changed or dropped. With no rows, every current
-- screen and job behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma; (2) row-level security for the new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern), after its runtime-role grant.

-- CreateTable
CREATE TABLE "MetaInstagramCommentPoll" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "instagramId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "commentsCount" INTEGER NOT NULL,
    "newestCommentAt" TIMESTAMP(3),
    "polledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaInstagramCommentPoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaInstagramCommentPoll_workspaceId_idx" ON "MetaInstagramCommentPoll"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaInstagramCommentPoll_workspaceId_instagramId_mediaId_key" ON "MetaInstagramCommentPoll"("workspaceId", "instagramId", "mediaId");

-- ── (2) Row-level security for MetaInstagramCommentPoll ──────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MetaInstagramCommentPoll" TO nexus_workspace_runtime;
ALTER TABLE "MetaInstagramCommentPoll" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetaInstagramCommentPoll" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "MetaInstagramCommentPoll";
CREATE POLICY nexus_workspace_isolation ON "MetaInstagramCommentPoll" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaInstagramCommentPoll"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "MetaInstagramCommentPoll"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "MetaInstagramCommentPoll";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "MetaInstagramCommentPoll" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
