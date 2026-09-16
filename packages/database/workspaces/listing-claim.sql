-- BP.S3 — one seller coordinate, one owning business.
--
-- The PRIMARY KEY (connectionId, marketplace, sellerSku) is the exclusivity. Two
-- businesses sharing one seller account share ONE SKU namespace, so the second
-- attempt to claim a coordinate collides at the database (23505) rather than
-- overwriting a live listing or pushing a second quantity at it.
--
-- Read by anyone who can see the account; written only by the business that holds
-- it. A guest must be able to READ a claim it does not hold — that is how the
-- refusal can say "another profile already publishes this SKU here" instead of
-- failing with nothing to show.

ALTER TABLE "ChannelListingClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelListingClaim" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelListingClaim" TO nexus_workspace_runtime;

-- Visible when the caller can see the underlying account. That subquery runs under
-- the caller's own policies on ChannelConnection, so it already honours BP.S1a's
-- share and BP.S2's per-person restriction: a member limited away from an account
-- cannot read its claims either.
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelListingClaim";
CREATE POLICY nexus_workspace_isolation ON "ChannelListingClaim" FOR SELECT TO nexus_workspace_runtime
USING (EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c.id = "ChannelListingClaim"."connectionId"));

-- Only the holder may release or move its own claim, and only into its own name.
-- WITH CHECK pins `workspaceId` to the caller, so a business cannot insert a claim
-- in someone else's name, and cannot rewrite an existing claim to point at itself.
DROP POLICY IF EXISTS nexus_workspace_claim_manage ON "ChannelListingClaim";
CREATE POLICY nexus_workspace_claim_manage ON "ChannelListingClaim" FOR ALL TO nexus_workspace_runtime
USING (
  "workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
  AND EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c.id = "ChannelListingClaim"."connectionId")
)
WITH CHECK (
  "workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
  AND EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c.id = "ChannelListingClaim"."connectionId")
);
