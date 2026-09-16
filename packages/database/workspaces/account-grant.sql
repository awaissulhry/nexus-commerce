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
