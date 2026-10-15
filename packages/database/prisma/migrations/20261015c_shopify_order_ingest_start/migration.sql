-- Shopify order import (2026-10-15) — the start date (T0) per Shopify account. Additive only: one new
-- business-owned table; nothing existing is altered, so every current screen and job behaves exactly as before.
--
--   "ShopifyOrderIngest"  one row per Shopify account a person switched order import on for
--                         (POST /api/shopify/order-import/:accountId/start). activatedAt is T0: the database clock's
--                         whole second, written once, never rewritten. A Shopify order created before it is never
--                         imported (apps/api/src/services/shopify/order-ingest-switch.ts). No row = no import.
--
-- Rollback: DROP TABLE "ShopifyOrderIngest"; nothing else depends on it. It cascades with its connection, like the
-- connection's other dependents (EtsyReceiptIngest, 20260926p).
--
-- Order: (1) what Prisma derives from schema.prisma; (2) row-level security for the new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets.

-- The foreign key locks "ChannelConnection", which every request reads: fail fast (the release is retried) rather
-- than queue behind a long transaction and hold up traffic behind the lock.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "ShopifyOrderIngest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT date_trunc('second'::text, clock_timestamp()),
    "activatedBy" TEXT,

    CONSTRAINT "ShopifyOrderIngest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyOrderIngest_workspaceId_idx" ON "ShopifyOrderIngest"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOrderIngest_connectionId_key" ON "ShopifyOrderIngest"("workspaceId", "connectionId");

-- AddForeignKey
ALTER TABLE "ShopifyOrderIngest" ADD CONSTRAINT "ShopifyOrderIngest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShopifyOrderIngest" TO nexus_workspace_runtime;
ALTER TABLE "ShopifyOrderIngest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyOrderIngest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ShopifyOrderIngest";
CREATE POLICY nexus_workspace_isolation ON "ShopifyOrderIngest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShopifyOrderIngest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShopifyOrderIngest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ShopifyOrderIngest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ShopifyOrderIngest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"connectionId","to":"id"}]');

COMMIT;
