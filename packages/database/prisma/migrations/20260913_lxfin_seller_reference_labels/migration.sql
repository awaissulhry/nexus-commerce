BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- R-LX-24 (on LX.R's R-LX-12) — the seller-owned reference-label cache.
--
-- Authored OUTSIDE `packages/database/prisma/migrations/` on purpose (PES.0 ruling #12: a lane does not
-- put a migration folder in the deploy path; `prisma migrate deploy` drags PARKED folders —
-- `reference_migrate_deploy_drags_parked_migrations`). Applied to LOCAL only, with
-- `current_database()` asserted first. The prod apply is the Owner's.
--
-- ADDITIVE AND REVERSIBLE. One new table, nothing altered, no backfill and no data dependency: every row
-- is DERIVED from a provider answer, so an empty table behaves exactly as today (the cold page load shows
-- the raw option id and the wire says `sellerTemplates: 'cache-miss'`). `DROP TABLE
-- "SellerReferenceLabel";` is a complete rollback.
--
-- WHY THE UNIQUE KEY CARRIES `connectionId`: seller templates belong to the seller. Naming account B's
-- templates from account A's definition is the defect `isPrimaryChannelConnection` already refuses in
-- `reference-labels.service.ts`, and a cache keyed without the connection would reintroduce it silently
-- and durably.
--
-- `workspaceId` has the same generated default as every other business table here, so a row written
-- inside a request lands in the caller's workspace without the service naming it.
--
-- ── LOCAL apply, 2026-09-13 ─────────────────────────────────────────────────────────────────────────
--   npx prisma db execute --url "<apps/api/.env DATABASE_URL>" \
--     --file docs/audits/2026-09-13-lx-fin/20260913_lxfin_seller_reference_labels.sql
-- ── PROD apply (the Owner's word only) ──────────────────────────────────────────────────────────────
--   Same SQL, against Neon with `-pooler` stripped from the host (`reference_neon_migrations`), then
--   `npx prisma generate` on the deploy. No downtime: nothing reads the table until the deploy that
--   ships the service change, and that code treats an empty table as today's behaviour.

CREATE TABLE IF NOT EXISTS "SellerReferenceLabel" (
  "workspaceId"  TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
  "id"           TEXT NOT NULL,
  "channel"      TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace"  TEXT NOT NULL,
  "productType"  TEXT NOT NULL,
  "fieldKey"     TEXT NOT NULL,
  "labels"       JSONB NOT NULL,
  "fetchedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerReferenceLabel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SellerReferenceLabel_channel_connection_market_type_field_uq"
  ON "SellerReferenceLabel" ("workspaceId", "channel", "connectionId", "marketplace", "productType", "fieldKey");

CREATE INDEX IF NOT EXISTS "SellerReferenceLabel_workspaceId_idx"
  ON "SellerReferenceLabel" ("workspaceId");

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

COMMIT;
