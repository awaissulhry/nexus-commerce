-- BP.S1a — one owner, many guests. Spec: docs/2026-09-16-bp-shared-accounts-and-access.md
--
-- ChannelAccountOwnership keys a seller account to exactly ONE business, and
-- apps/api/src/lib/workspace-ingress.ts:6 depends on that: a verified notification
-- resolving to more than one business is refused with 503 ingress_account_ambiguous.
-- So a second business never becomes a co-owner. It gets a READ-ONLY grant, and
-- inbound routing is untouched because a grant creates no ChannelAccountRoute row.
--
-- Additive: one new table, two new FOR SELECT policies. No existing policy, column,
-- constraint or row is modified.

CREATE TABLE "ChannelAccountGrant" (
    "connectionId"     TEXT NOT NULL,
    "workspaceId"      TEXT NOT NULL,
    "ownerWorkspaceId" TEXT NOT NULL,
    "mode"             TEXT NOT NULL DEFAULT 'read',
    "marketplaces"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "grantedByUserId"  TEXT NOT NULL,
    "grantedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"        TIMESTAMP(3),
    "revokedByUserId"  TEXT,
    CONSTRAINT "ChannelAccountGrant_pkey" PRIMARY KEY ("connectionId", "workspaceId")
);

-- 'publish' is storable but NOT honoured until BP.S3 ships the listing-claim index;
-- the write path refuses it. The value is constrained here so a typo cannot create a
-- grant whose mode no reader recognises.
ALTER TABLE "ChannelAccountGrant"
  ADD CONSTRAINT "ChannelAccountGrant_mode_check" CHECK ("mode" IN ('read', 'publish'));

-- A grant to the owning business is a no-op that would read as a real share.
ALTER TABLE "ChannelAccountGrant"
  ADD CONSTRAINT "ChannelAccountGrant_distinct_profiles_check" CHECK ("workspaceId" <> "ownerWorkspaceId");

CREATE INDEX "ChannelAccountGrant_workspaceId_idx" ON "ChannelAccountGrant"("workspaceId");
CREATE INDEX "ChannelAccountGrant_ownerWorkspaceId_idx" ON "ChannelAccountGrant"("ownerWorkspaceId");

ALTER TABLE "ChannelAccountGrant" ADD CONSTRAINT "ChannelAccountGrant_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT on both businesses: an outstanding grant must be revoked deliberately,
-- never swept by deleting a business row.
ALTER TABLE "ChannelAccountGrant" ADD CONSTRAINT "ChannelAccountGrant_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChannelAccountGrant" ADD CONSTRAINT "ChannelAccountGrant_ownerWorkspaceId_fkey"
  FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ChannelAccountGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelAccountGrant" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChannelAccountGrant" TO nexus_workspace_runtime;

-- This table deliberately links TWO businesses, so it gets no
-- nexus_workspace_reference_guard trigger — that guard exists to reject exactly the
-- cross-business link this row IS.

-- ── Owner-only management ─────────────────────────────────────────────────────
-- FOR ALL, so INSERT / UPDATE / DELETE are the owner's alone. Revocation is a
-- revokedAt write, not a DELETE, so history survives.
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelAccountGrant";
CREATE POLICY nexus_workspace_isolation ON "ChannelAccountGrant" FOR ALL TO nexus_workspace_runtime
USING (("ownerWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelAccountGrant"."ownerWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("ownerWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelAccountGrant"."ownerWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- ── The guest may READ its own grant, and nothing else ────────────────────────
-- 🔴 FOR SELECT, never a second arm on the FOR ALL policy above. DELETE consults
-- USING alone and never reaches WITH CHECK, so widening that USING would have let a
-- guest delete the grant (and, on ChannelConnection below, the account itself).
DROP POLICY IF EXISTS nexus_workspace_grant_guest_read ON "ChannelAccountGrant";
CREATE POLICY nexus_workspace_grant_guest_read ON "ChannelAccountGrant" FOR SELECT TO nexus_workspace_runtime
USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ChannelAccountGrant"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- ── The shared account itself, read-only for the guest ────────────────────────
-- Permissive policies are OR-combined PER COMMAND, so this adds SELECT and adds
-- nothing else: UPDATE/DELETE/INSERT still consult nexus_workspace_isolation alone
-- and find no row. The membership arm is the same one every isolation policy uses,
-- so a person who is not an active member of the GUEST business gains nothing.
--
-- Column-level hiding is not available here: the owner and the guest share one
-- database role, so a column GRANT cannot distinguish them. Credentials are kept
-- from the guest at the application layer instead, where the split already exists —
-- CONNECTION_PUBLIC_SELECT (connection-resolver.service.ts:43) names every column a
-- caller may read and lists no credential column, and services/cx/token.service.ts
-- is the only module that decrypts. BP.S1b adds its ownership guard.
DROP POLICY IF EXISTS nexus_workspace_grant_read ON "ChannelConnection";
CREATE POLICY nexus_workspace_grant_read ON "ChannelConnection" FOR SELECT TO nexus_workspace_runtime
USING (EXISTS (
  SELECT 1 FROM "ChannelAccountGrant" g JOIN "Workspace" w ON w.id = g."workspaceId"
  WHERE g."connectionId" = "ChannelConnection".id
    AND g."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND g."revokedAt" IS NULL
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
      WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
        AND m.status = 'active' AND u.status = 'active'))));

-- The account's marketplaces/shops/profiles. Without these the shared account
-- renders with no destinations and reads as broken rather than shared.
DROP POLICY IF EXISTS nexus_workspace_grant_read ON "ConnectionScope";
CREATE POLICY nexus_workspace_grant_read ON "ConnectionScope" FOR SELECT TO nexus_workspace_runtime
USING (EXISTS (
  SELECT 1 FROM "ChannelAccountGrant" g JOIN "Workspace" w ON w.id = g."workspaceId"
  WHERE g."connectionId" = "ConnectionScope"."connectionId"
    AND g."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND g."revokedAt" IS NULL
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
      WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
        AND m.status = 'active' AND u.status = 'active'))));
