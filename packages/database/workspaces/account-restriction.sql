-- BP.S2 — which accounts one PERSON may reach inside one business.
--
-- MAP.8 parked this in August because apps/api/src/lib/auth/rbac-hook.ts resolves a
-- permission from (method, pattern) in a preHandler and therefore cannot know WHICH
-- account a request will touch. That is still true. This does not solve it there —
-- it moves the question to the one layer that always knows: the row itself.
--
-- `nexus_account_restriction` is RESTRICTIVE, so PostgreSQL ANDs it with every
-- permissive policy on the table rather than OR-ing it in. One statement therefore
-- covers owned accounts AND accounts shared in by another business (BP.S1a), reads
-- AND writes, every one of the 46 named lookups, with no call site changed.

ALTER TABLE "WorkspaceMemberAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMemberAccount" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkspaceMemberAccount" TO nexus_workspace_runtime;
ALTER TABLE "WorkspaceMemberAccountLimit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMemberAccountLimit" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WorkspaceMemberAccountLimit" TO nexus_workspace_runtime;

-- 🔴 The restricted person MUST be able to read their own allow-list, because the
-- policy below asks this table whether they may see an account. Hide these rows from
-- them and the third arm finds nothing, so a restricted member would see NO accounts
-- at all — a total lock-out that looks exactly like a correctly narrow restriction.
-- Any active member of the business may read the list; it is an access roster, not a
-- secret, and the team page shows it.
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WorkspaceMemberAccount";
CREATE POLICY nexus_workspace_isolation ON "WorkspaceMemberAccount" FOR SELECT TO nexus_workspace_runtime
USING (EXISTS (
  SELECT 1 FROM "WorkspaceMembership" m JOIN "Workspace" w ON w.id = m."workspaceId"
  WHERE m.id = "WorkspaceMemberAccount"."membershipId"
    AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" me JOIN "UserProfile" u ON u.id = me."userId"
      WHERE me."workspaceId" = w.id AND me."userId" = current_setting('nexus.actor_id', true)
        AND me.status = 'active' AND u.status = 'active'))));

-- Writing the roster is an OWNER act, like sharing an account (BP.S1c).
DROP POLICY IF EXISTS nexus_workspace_member_access_manage ON "WorkspaceMemberAccount";
CREATE POLICY nexus_workspace_member_access_manage ON "WorkspaceMemberAccount" FOR ALL TO nexus_workspace_runtime
USING (EXISTS (
  SELECT 1 FROM "WorkspaceMembership" m JOIN "Workspace" w ON w.id = m."workspaceId"
  WHERE m.id = "WorkspaceMemberAccount"."membershipId"
    AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" me
      JOIN "UserProfile" u ON u.id = me."userId"
      JOIN "WorkspaceMemberRole" mr ON mr."membershipId" = me.id
      JOIN "Role" r ON r.id = mr."roleId"
      WHERE me."workspaceId" = w.id AND me."userId" = current_setting('nexus.actor_id', true)
        AND me.status = 'active' AND u.status = 'active' AND r.key = 'OWNER'))))
WITH CHECK (EXISTS (
  SELECT 1 FROM "WorkspaceMembership" m JOIN "Workspace" w ON w.id = m."workspaceId"
  WHERE m.id = "WorkspaceMemberAccount"."membershipId"
    AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" me
      JOIN "UserProfile" u ON u.id = me."userId"
      JOIN "WorkspaceMemberRole" mr ON mr."membershipId" = me.id
      JOIN "Role" r ON r.id = mr."roleId"
      WHERE me."workspaceId" = w.id AND me."userId" = current_setting('nexus.actor_id', true)
        AND me.status = 'active' AND u.status = 'active' AND r.key = 'OWNER'))));


-- The LIMIT row carries the same two policies as the list: everyone in the business
-- may read it (the team page shows who is limited), only an owner may write it. It is
-- a row rather than a boolean on WorkspaceMembership because that table has NO
-- row-level security — measured 2026-09-16, a non-owner can UPDATE their own
-- membership — so a flag there could be lifted by the person it restricts.
DROP POLICY IF EXISTS nexus_workspace_isolation ON "WorkspaceMemberAccountLimit";
CREATE POLICY nexus_workspace_isolation ON "WorkspaceMemberAccountLimit" FOR SELECT TO nexus_workspace_runtime
USING (EXISTS (
  SELECT 1 FROM "WorkspaceMembership" m JOIN "Workspace" w ON w.id = m."workspaceId"
  WHERE m.id = "WorkspaceMemberAccountLimit"."membershipId"
    AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" me JOIN "UserProfile" u ON u.id = me."userId"
      WHERE me."workspaceId" = w.id AND me."userId" = current_setting('nexus.actor_id', true)
        AND me.status = 'active' AND u.status = 'active'))));

DROP POLICY IF EXISTS nexus_workspace_member_limit_manage ON "WorkspaceMemberAccountLimit";
CREATE POLICY nexus_workspace_member_limit_manage ON "WorkspaceMemberAccountLimit" FOR ALL TO nexus_workspace_runtime
USING (EXISTS (
  SELECT 1 FROM "WorkspaceMembership" m JOIN "Workspace" w ON w.id = m."workspaceId"
  WHERE m.id = "WorkspaceMemberAccountLimit"."membershipId"
    AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" me
      JOIN "UserProfile" u ON u.id = me."userId"
      JOIN "WorkspaceMemberRole" mr ON mr."membershipId" = me.id
      JOIN "Role" r ON r.id = mr."roleId"
      WHERE me."workspaceId" = w.id AND me."userId" = current_setting('nexus.actor_id', true)
        AND me.status = 'active' AND u.status = 'active' AND r.key = 'OWNER'))))
WITH CHECK (EXISTS (
  SELECT 1 FROM "WorkspaceMembership" m JOIN "Workspace" w ON w.id = m."workspaceId"
  WHERE m.id = "WorkspaceMemberAccountLimit"."membershipId"
    AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND w.status = 'active'
    AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" me
      JOIN "UserProfile" u ON u.id = me."userId"
      JOIN "WorkspaceMemberRole" mr ON mr."membershipId" = me.id
      JOIN "Role" r ON r.id = mr."roleId"
      WHERE me."workspaceId" = w.id AND me."userId" = current_setting('nexus.actor_id', true)
        AND me.status = 'active' AND u.status = 'active' AND r.key = 'OWNER'))));

-- ── The restriction itself ───────────────────────────────────────────────────
--
-- Three arms, in the order they are cheapest to answer:
--   1. No actor — a background job, a webhook, a queue worker. Unrestricted, because
--      a restriction is about a PERSON and scheduled work has none. Matches the
--      `actor IS NULL` arm every isolation policy already uses.
--   2. This person is not restricted in this business. The default, and the fast path.
--   3. This account is on their list.
--
-- 🔴 WITH CHECK repeats USING, which means a restricted member cannot INSERT a
-- ChannelConnection: a brand-new row cannot already be on their list. That is the
-- honest reading of "restricted to these accounts" — connecting a new seller account
-- is account administration, not use of an assigned one — and it fails at the
-- database rather than halfway through an OAuth callback.
DROP POLICY IF EXISTS nexus_account_restriction ON "ChannelConnection";
CREATE POLICY nexus_account_restriction ON "ChannelConnection" AS RESTRICTIVE FOR ALL TO nexus_workspace_runtime
USING (
  NULLIF(current_setting('nexus.actor_id', true), '') IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM "WorkspaceMemberAccountLimit" l JOIN "WorkspaceMembership" m ON m.id = l."membershipId"
    WHERE m."userId" = current_setting('nexus.actor_id', true)
      AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
      AND m.status = 'active')
  OR EXISTS (
    SELECT 1 FROM "WorkspaceMemberAccount" ma JOIN "WorkspaceMembership" m ON m.id = ma."membershipId"
    WHERE m."userId" = current_setting('nexus.actor_id', true)
      AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
      AND m.status = 'active'
      AND ma."connectionId" = "ChannelConnection".id)
)
WITH CHECK (
  NULLIF(current_setting('nexus.actor_id', true), '') IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM "WorkspaceMemberAccountLimit" l JOIN "WorkspaceMembership" m ON m.id = l."membershipId"
    WHERE m."userId" = current_setting('nexus.actor_id', true)
      AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
      AND m.status = 'active')
  OR EXISTS (
    SELECT 1 FROM "WorkspaceMemberAccount" ma JOIN "WorkspaceMembership" m ON m.id = ma."membershipId"
    WHERE m."userId" = current_setting('nexus.actor_id', true)
      AND m."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
      AND m.status = 'active'
      AND ma."connectionId" = "ChannelConnection".id)
);
