-- R-LX-24, part 2 — the GRANT and the row-level policy the table cannot work without.
--
-- 🔴 WHY THIS FILE EXISTS. The table creation alone was NOT enough, and the failure mode is silent:
-- `packages/database/workspace-adapter.js:11` runs `SET LOCAL ROLE nexus_workspace_runtime` on every
-- routed query, and a new table is not readable by that role by default. MEASURED on LOCAL through the
-- application's own Prisma client on 2026-09-13: both the read and the write answered
-- `42501 permission denied for table SellerReferenceLabel`. Because `reference-labels.service.ts`
-- swallows a cache read/write failure on purpose (a label cache must never fail the page it rode in
-- on), the whole feature would have been a no-op with nothing on the wire to say so — the stamp would
-- read `sellerTemplateSource: 'none'` and a cold page would show the raw template id, exactly as before.
--
-- The GRANT is guarded on the role existing, the way `20260912_lx5_readiness_index` guards its own, so
-- this file is safe on a database that has no workspace runtime role (a disposable test database).
--
-- 🔴 ONE THING FOR THE OWNER, deliberately not decided here: the POLICY predicate. This is the SIMPLE
-- workspace predicate. `20260911_category_taxonomies` uses a FULLER one that also joins `Workspace` and
-- `WorkspaceMembership` to check that the workspace is active and the actor is a member. For a DERIVED,
-- disposable label cache the simple predicate is proportionate — nothing here is business data and
-- dropping the table costs one live call per gesture — but if the project's standard for every table is
-- the fuller predicate, use the fuller one. I did not invent a third variant.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SellerReferenceLabel" TO nexus_workspace_runtime;
  END IF;
END $$;

ALTER TABLE "SellerReferenceLabel" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_workspace_runtime')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'SellerReferenceLabel' AND policyname = 'nexus_workspace_isolation') THEN
    CREATE POLICY nexus_workspace_isolation ON "SellerReferenceLabel" FOR ALL TO nexus_workspace_runtime
      USING ("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), ''))
      WITH CHECK ("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), ''));
  END IF;
END $$;
