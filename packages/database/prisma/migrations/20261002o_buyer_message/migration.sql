-- MCP full control 07 O11 (docs/mcp-full-control/sections/07-orders.md §4) — BuyerMessage: one row per message to a
-- buyer, written by the one buyer-message door (apps/api/src/services/comms/buyer-message.service.ts). Additive only:
-- one new business-owned table; nothing existing is modified, and with no rows every current screen and job behaves
-- exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets (the 20260923a
-- pattern).
-- CreateTable
CREATE TABLE "BuyerMessage" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "template" TEXT,
    "language" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "error" TEXT,
    "sentByUserId" TEXT,
    "via" TEXT NOT NULL,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "BuyerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuyerMessage_orderId_idx" ON "BuyerMessage"("orderId");

-- CreateIndex
CREATE INDEX "BuyerMessage_workspaceId_createdAt_idx" ON "BuyerMessage"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "BuyerMessage_workspaceId_idx" ON "BuyerMessage"("workspaceId");

-- AddForeignKey
ALTER TABLE "BuyerMessage" ADD CONSTRAINT "BuyerMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BuyerMessage" TO nexus_workspace_runtime;
ALTER TABLE "BuyerMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BuyerMessage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "BuyerMessage";
CREATE POLICY nexus_workspace_isolation ON "BuyerMessage" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BuyerMessage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "BuyerMessage"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "BuyerMessage";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "BuyerMessage" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"orderId","to":"id"}]');
