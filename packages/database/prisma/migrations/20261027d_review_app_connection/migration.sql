-- Reviews: Etsy reviews and the store's review app (2026-10-27, Reviews area rebuild PR I).
--
--   Review.channelEditedAt  when the buyer last edited the review on the channel (Etsy's update_timestamp). Etsy allows
--                           one seller reply within 100 days of that edit, so the reply window counts from it. Null for
--                           every existing row and for channels that do not say (the window then counts from postedAt).
--   ReviewAppConnection     the store's review app a business connected (Judge.me today; Okendo, Yotpo and Loox later):
--                           one row per business and app (unique workspaceId + app), the shop domain, the API key as an
--                           encryptCredentials blob (never returned, never logged; null once disconnected), its state and
--                           when Nexus last read it.
--
-- Additive only: one nullable column and one new business-owned table; nothing existing is changed or dropped. With no
-- rows and no values, every current screen and job behaves exactly as before.
--
-- Order: (1) the DDL Prisma derives from schema.prisma (prisma migrate diff, schema to schema, offline); (2) row-level
-- security for the new table, emitted by workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern),
-- after its runtime-role grant.
--
-- Rollback: DROP TABLE "ReviewAppConnection"; ALTER TABLE "Review" DROP COLUMN "channelEditedAt";

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "channelEditedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReviewAppConnection" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "credentials" TEXT,
    "credentialsKeyId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastReadAt" TIMESTAMP(3),
    "lastReadCount" INTEGER,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewAppConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewAppConnection_workspaceId_idx" ON "ReviewAppConnection"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewAppConnection_workspace_app_key" ON "ReviewAppConnection"("workspaceId", "app");

-- ── (2) Row-level security for ReviewAppConnection ───────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReviewAppConnection" TO nexus_workspace_runtime;
ALTER TABLE "ReviewAppConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewAppConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ReviewAppConnection";
CREATE POLICY nexus_workspace_isolation ON "ReviewAppConnection" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewAppConnection"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ReviewAppConnection"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ReviewAppConnection";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ReviewAppConnection" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[]');
