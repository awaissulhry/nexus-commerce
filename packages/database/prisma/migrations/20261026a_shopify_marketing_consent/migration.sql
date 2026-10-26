-- Shopify marketing consent (2026-10-26; Owner decision D8 and follow-up (a) of the Meta ads build) — a Shopify buyer's
-- e-mail marketing consent, copied into Nexus so a later step can build a Meta customer list from buyers who said yes.
--
--   ShopifyMarketingConsent   one row per Shopify customer of one Shopify account this business owns, for buyers only
--                             (at least one Shopify order, any date). The e-mail is NEVER stored: only its SHA-256 after
--                             Meta's customer-list normalisation (trim, lower case). Plus Shopify's marketing state, the
--                             time the consent last changed, and which path wrote it (backfill | webhook | order). Its
--                             account is a foreign key (ON DELETE CASCADE: the rows go with the account), and the
--                             reference guard refuses a row that names another business's account.
--
-- Additive only: one new business-owned table; nothing existing is changed or dropped. With no rows, every current
-- screen and job behaves exactly as before. Nothing reads it to send anything yet.
--
-- Order: (1) the DDL Prisma derives from schema.prisma; (2) row-level security for the new table, emitted by
-- workspaceModelSql() in scripts/workspace-policies.mjs (20260923a pattern), after its runtime-role grant.
--
-- Rollback: DROP TABLE "ShopifyMarketingConsent";

-- CreateTable
CREATE TABLE "ShopifyMarketingConsent" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "emailSha256" TEXT NOT NULL,
    "emailState" TEXT NOT NULL,
    "emailConsentAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyMarketingConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyMarketingConsent_workspaceId_emailSha256_idx" ON "ShopifyMarketingConsent"("workspaceId", "emailSha256");

-- CreateIndex
CREATE INDEX "ShopifyMarketingConsent_workspaceId_idx" ON "ShopifyMarketingConsent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyMarketingConsent_workspaceId_connectionId_shopifyCus_key" ON "ShopifyMarketingConsent"("workspaceId", "connectionId", "shopifyCustomerId");

-- AddForeignKey
ALTER TABLE "ShopifyMarketingConsent" ADD CONSTRAINT "ShopifyMarketingConsent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── (2) Row-level security for ShopifyMarketingConsent ───────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShopifyMarketingConsent" TO nexus_workspace_runtime;
ALTER TABLE "ShopifyMarketingConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyMarketingConsent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ShopifyMarketingConsent";
CREATE POLICY nexus_workspace_isolation ON "ShopifyMarketingConsent" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShopifyMarketingConsent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShopifyMarketingConsent"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ShopifyMarketingConsent";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ShopifyMarketingConsent" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"ChannelConnection","from":"connectionId","to":"id"}]');
