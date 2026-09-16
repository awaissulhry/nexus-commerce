-- L1 (2026-09-16) — membership and role WRITE protection.
-- Spec: docs/2026-09-16-bp-shared-accounts-and-access.md §15.1.
--
-- Additive: enables row-level security on two tables that had none and adds four
-- policies. Reads stay open, so the login path is untouched — see the note below,
-- and the rehearsal arms that prove sign-in and business creation still work.

-- L1 (2026-09-16) — membership and role writes, at the database.
--
-- Measured before writing this: `WorkspaceMembership`, `WorkspaceMemberRole` and
-- `Workspace` had `relrowsecurity = false` and ZERO policies, and a non-owner context
-- ran `UPDATE "WorkspaceMembership" … → UPDATED 1 row(s)`. They are `globalModels`,
-- which grants the runtime role access and generates no policy. Access was therefore
-- enforced only by `workspace.service.requireOwner` — correct today, and one careless
-- route away from not being.
--
-- 🔴 READS STAY OPEN, and that is not laziness.
--
-- `workspace-hook.ts:97` resolves `service.membership(user, id)` BEFORE it opens a
-- workspace context, because the membership is what decides the context. A read
-- policy keyed on `nexus.workspace_id` would evaluate against '' and return nothing,
-- and EVERY sign-in would fail. So reads are unrestricted and only writes are gated —
-- which is where the elevation risk actually lives. Two permissive policies:
-- PostgreSQL ORs them per command, so SELECT passes through the open one while
-- INSERT/UPDATE/DELETE consult only the guarded one.

ALTER TABLE "WorkspaceMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMembership" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMemberRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMemberRole" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nexus_membership_read ON "WorkspaceMembership";
CREATE POLICY nexus_membership_read ON "WorkspaceMembership" FOR SELECT TO nexus_workspace_runtime USING (true);
DROP POLICY IF EXISTS nexus_member_role_read ON "WorkspaceMemberRole";
CREATE POLICY nexus_member_role_read ON "WorkspaceMemberRole" FOR SELECT TO nexus_workspace_runtime USING (true);

-- The write rule, three arms:
--   1. No actor — migrations, backfills, the seeder, queue workers. These already run
--      outside a person's session and the isolation policies use the same arm.
--   2. The actor is an active OWNER of THAT row's business. The ordinary path.
--   3. The business has NO members yet AND the row being written is the actor's own.
--      This is `workspace.service.create`, which inserts the workspace and its first
--      owner in one transaction: at that moment no OWNER membership exists to check
--      against, so arm 2 cannot fire. Restricting it to the actor's own row means a
--      memberless business can be claimed only by the person claiming it, never
--      populated with someone else.
CREATE OR REPLACE FUNCTION nexus_may_write_membership(target_workspace text, target_user text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    NULLIF(current_setting('nexus.actor_id', true), '') IS NULL
    OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" me
      JOIN "UserProfile" u ON u.id = me."userId"
      JOIN "WorkspaceMemberRole" mr ON mr."membershipId" = me.id
      JOIN "Role" r ON r.id = mr."roleId"
      WHERE me."workspaceId" = target_workspace
        AND me."userId" = current_setting('nexus.actor_id', true)
        AND me.status = 'active' AND u.status = 'active' AND r.key = 'OWNER')
    OR (
      NOT EXISTS (SELECT 1 FROM "WorkspaceMembership" x WHERE x."workspaceId" = target_workspace)
      AND target_user = current_setting('nexus.actor_id', true));
$$;
REVOKE ALL ON FUNCTION nexus_may_write_membership(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_may_write_membership(text, text) TO nexus_workspace_runtime;

DROP POLICY IF EXISTS nexus_membership_write ON "WorkspaceMembership";
CREATE POLICY nexus_membership_write ON "WorkspaceMembership" FOR ALL TO nexus_workspace_runtime
USING (nexus_may_write_membership("workspaceId", "userId"))
WITH CHECK (nexus_may_write_membership("workspaceId", "userId"));

-- Roles are HOW owner is conferred, so leaving them open would leave the membership
-- guard decorative: a member could grant themselves OWNER and then edit anything.
--
-- 🔴 Its bootstrap arm is NOT the membership one, and the rehearsal is what proved
-- it. `workspace.service.create` inserts the workspace, then the membership, then its
-- OWNER role. By the third statement a membership DOES exist, so the membership
-- guard's "no members yet" arm has already closed — and no OWNER role exists yet for
-- arm 2 to find. Reusing that function made creating a business fail with 42501.
--
-- The precise creation moment instead: the actor's OWN membership, with no roles yet,
-- in a business that has exactly ONE membership. Requiring all three means a member
-- of an established business can never reach it, because their business has others in
-- it and their membership already carries a role.
CREATE OR REPLACE FUNCTION nexus_may_write_member_role(membership_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    NULLIF(current_setting('nexus.actor_id', true), '') IS NULL
    OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" target
      JOIN "WorkspaceMembership" me ON me."workspaceId" = target."workspaceId"
      JOIN "UserProfile" u ON u.id = me."userId"
      JOIN "WorkspaceMemberRole" mr ON mr."membershipId" = me.id
      JOIN "Role" r ON r.id = mr."roleId"
      WHERE target.id = membership_id
        AND me."userId" = current_setting('nexus.actor_id', true)
        AND me.status = 'active' AND u.status = 'active' AND r.key = 'OWNER')
    OR EXISTS (
      SELECT 1 FROM "WorkspaceMembership" target
      WHERE target.id = membership_id
        AND target."userId" = current_setting('nexus.actor_id', true)
        AND NOT EXISTS (SELECT 1 FROM "WorkspaceMemberRole" mr WHERE mr."membershipId" = target.id)
        AND (SELECT count(*) FROM "WorkspaceMembership" x WHERE x."workspaceId" = target."workspaceId") = 1);
$$;
REVOKE ALL ON FUNCTION nexus_may_write_member_role(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_may_write_member_role(text) TO nexus_workspace_runtime;

DROP POLICY IF EXISTS nexus_member_role_write ON "WorkspaceMemberRole";
CREATE POLICY nexus_member_role_write ON "WorkspaceMemberRole" FOR ALL TO nexus_workspace_runtime
USING (nexus_may_write_member_role("membershipId"))
WITH CHECK (nexus_may_write_member_role("membershipId"));
