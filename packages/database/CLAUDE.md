# packages/database

Prisma schema (`prisma/schema.prisma`), migrations, and the workspace-aware client that every consumer imports.
Consumers load the committed `*.js` files at this package root. After you edit a `*.ts` here, run
`npm run build -w @nexus/database` and commit both.

## Tenant scope (row-level security)
- Every query goes through the `WorkspacePg` adapter (`workspace-adapter.ts`). Inside each transaction it runs
  `SET LOCAL ROLE nexus_workspace_runtime` and `set_config('nexus.workspace_id', <id>, true)`. The policies from
  `scripts/workspace-policies.mjs` then show only that workspace's rows.
- The helper is `withWorkspace(context, work)` from `@nexus/database/workspace-context`; the API re-exports it from
  `apps/api/src/lib/workspace-context.ts`.
  - API requests get it from `apps/api/src/lib/workspace-hook.ts`.
  - Deferred work keeps it with `captureWorkspace()`.
  - Crons and timers get it as described in `apps/api/CLAUDE.md`.
- What happens without a context:
  - `NEXUS_WORKSPACES_ENABLED` off: every query silently runs as the legacy workspace (`nexus_legacy_workspace`).
  - `NEXUS_WORKSPACES_ENABLED=1`: a Prisma call on a business-owned model throws `WorkspaceError('workspace_required')`.
    Raw SQL runs with an empty workspace id: reads return zero rows, and inserts fail the policy.
- Raw SQL: one statement only (`assertWorkspaceSql`, `workspace-sql.ts`). Never `SET ROLE`, `RESET`, `set_config`
  or `SET nexus.*`; the adapter rejects them. Raw SQL gets no automatic `workspaceId` filter; only RLS protects it.
- Never `new PrismaClient()` in app code. It skips the adapter, so it gets no workspace and no runtime role.

## Changing the schema
1. Edit `prisma/schema.prisma`.
2. Write the migration by hand: `prisma/migrations/<YYYYMMDD><letter>_<name>/migration.sql`, using the next free
   letter for the day. Generate the DDL with `npx prisma migrate diff` (the flags this Prisma version takes are in
   `apps/api/src/test-support/formula-database.ts`), and keep only your change.
3. For a new table, add the model to `workspaces/model-ownership.json`: under `workspaceModels` if one business owns
   each row, otherwise under `globalModels`.
   - For a business-owned table, also add its keys to `workspaces/scoped-keys.json`.
   - Append the output of `workspaceModelSql('<Model>')` from `scripts/workspace-policies.mjs` to the migration.
   - Example: `prisma/migrations/20260923a_channel_drift/migration.sql`.
4. Run `npm run check:drift`, `node packages/database/scripts/check-model-ownership.mjs` and
   `node packages/database/scripts/check-policy-migration-parity.mjs`.

**Expand/contract.** Migrations run while the previous release still serves traffic. So a release may only add
(tables, nullable columns, new enum values). Drops, renames and new NOT NULL constraints ship in a later release,
after no code or queued job reads the old shape. Park later-release SQL in `prisma/migrations-pending/`; Prisma does
not read that folder.

**`prisma migrate dev` does not work here.** The history does not replay from an empty database: it fails at
migration 19 with P3006 (`scripts/replay-migrations.mjs`). So there is no shadow database.

## Never
- Never run `prisma migrate reset`, `prisma db push` or `prisma migrate dev` against anything but a throwaway local
  database. The local dev database is shared with other sessions and the browser gates.
- Never run the Prisma CLI from the repo root. `prisma.config.ts` loads the `.env` of the current directory. Only
  `packages/database/.env` points at a local database; the root `.env` is production.

## Test databases
- `formulaDatabase()` (`apps/api/src/test-support/formula-database.ts`): in-process PGlite built from
  `schema.prisma` plus every policy. It has one connection, so it cannot show a race.
- `concurrentDatabase()` (`apps/api/src/test-support/concurrent-database.ts`): a new random database on the loopback
  server named by `NEXUS_TEST_CONCURRENT_PG_URL`.
- `node scripts/run-real-postgres-tests.mjs`: one throwaway PostgreSQL 17 container (it never pulls an image). A new
  suite must be added to its `SUITES` list.
- Tests that import the real client use the local dev database. `apps/api/src/lib/testing/database-target.ts`
  refuses anything that is not loopback `nexus_development` or `*test*`.
- To make a fresh local database: `DATABASE_URL=<loopback, empty> node packages/database/scripts/bootstrap-fresh-database.mjs`.
  It loads `prisma/baseline.sql`, marks every migration applied and installs the policies.
