-- Shopify colour products (docs/studies/shopify-linked-variations-PLAN.md §3.4, PR 3): on a store that shows each value
-- of a family's split axis (the colour) as its own Shopify product, one row per family, store, market, alias and value.
-- Additive only: one new business-owned table; nothing existing is modified, and with no rows every current screen and
-- job behaves exactly as before.
--
-- Order: (1) the table Prisma derives from schema.prisma; (2) row-level security, emitted by workspaceModelSql() in
-- scripts/workspace-policies.mjs so it carries the same bytes the disposable test database gets.

-- CreateTable
CREATE TABLE "ShopifyColourProduct" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'GLOBAL',
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "splitAxis" TEXT NOT NULL,
    "valueKey" TEXT NOT NULL,
    "colourName" TEXT,
    "shopifyProductId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'NOT_FOUND',
    "proposal" JSONB,
    "remoteStatus" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyColourProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyColourProduct_workspaceId_idx" ON "ShopifyColourProduct"("workspaceId");

-- CreateIndex
CREATE INDEX "ShopifyColourProduct_familyId_idx" ON "ShopifyColourProduct"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyColourProduct_workspaceId_channelConnectionId_market_key" ON "ShopifyColourProduct"("workspaceId", "channelConnectionId", "marketplace", "aliasKey", "familyId", "valueKey");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyColourProduct_workspaceId_channelConnectionId_shopif_key" ON "ShopifyColourProduct"("workspaceId", "channelConnectionId", "shopifyProductId");

-- AddForeignKey
ALTER TABLE "ShopifyColourProduct" ADD CONSTRAINT "ShopifyColourProduct_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyColourProduct" ADD CONSTRAINT "ShopifyColourProduct_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for the business-owned table ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShopifyColourProduct" TO nexus_workspace_runtime;
ALTER TABLE "ShopifyColourProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyColourProduct" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ShopifyColourProduct";
CREATE POLICY nexus_workspace_isolation ON "ShopifyColourProduct" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShopifyColourProduct"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShopifyColourProduct"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ShopifyColourProduct";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ShopifyColourProduct" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"familyId","to":"id"},{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
