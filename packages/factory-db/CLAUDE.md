# packages/factory-db — the factory's Prisma schema, migrations, policies and scoped client

Prisma 7.10 with a schema folder, `prisma/schema/`: `schema.prisma` holds the generator and the datasource, and each
module adds its own `<module>.prisma` (`_core.prisma`: Tenant, Company, Site, Line, WorkCentre, Station). The client is
generated into `src/generated/prisma` (git-ignored), never into `node_modules`, where Commerce's client lives.

## What it offers
- `@nexus/factory-db`: `openFactoryDatabase({ connectionString })` → `withScope(scope, client => …)`. One audited pg
  pool for the runtime login `factory_app` (db-kit's `AuditedPool`; the first connection is audited at open, so an
  unsafe login stops the boot), and one Prisma client per scope behind db-kit's `TenantPg`, kept in a cache (32, least
  recently used idle one closed). Scopes: `office` (tenantId, actorId), `floor` (+ siteId), `partner` (+ partyId),
  `platform` (none). Ids are UUIDs; a missing value throws before any query. Use a client only inside its callback.
  Also the model types and enums. Never the PrismaClient class.
- `@nexus/factory-db/testing`: `migratedDatabase(label)`, a throwaway database built from the migrations.
- `@nexus/factory-db/test-database`: the test-database guard.
- The walls (`src/roles.ts`, plan A1 §2.2): NOLOGIN roles `factory_runtime`, `factory_floor_runtime`,
  `factory_partner_runtime`, `factory_platform`; the login `factory_app` enters each WITH INHERIT FALSE, SET TRUE, so
  outside a role it reads nothing; only it may EXECUTE `set_config`. The migrations run as the owner login, never as
  `factory_app`; the migrations create `factory_app` without a password (Railway's is set once by hand).

## Commands
    cd packages/factory-db && npx prisma validate
    npm run generate -w @nexus/factory-db             # typecheck runs it first
    npm run typecheck -w @nexus/factory-db
    cd packages/factory-db && npx vitest run          # pure + real PostgreSQL (local stack), about 3 s
    node scripts/factory/run-pg-tests.mjs [filter]    # the PostgreSQL tests of every factory workspace
    node scripts/factory/check-ownership.mjs          # also in run-guards
    node scripts/factory/check-policy-parity.mjs      # also in run-guards
    node scripts/factory/check-migrations-replay.mjs  # = npm run check:drift -w @nexus/factory-db; needs the stack
    FACTORY_MIGRATION_DATABASE_URL=postgresql://postgres@127.0.0.1:5442/factory_<step> npm run migrate -w @nexus/factory-db
    FACTORY_DATABASE_URL=postgresql://factory_app@127.0.0.1:5442/factory_<step> npm run seed -w @nexus/factory-db

## A schema change
1. Edit your module's `prisma/schema/<module>.prisma` (conventions at the top of `_core.prisma`) and classify every new
   model in `ownership/<module>.json` (rules in `src/ownership.ts`).
2. `npm run migration -w @nexus/factory-db -- <YYYYMMDDHHmm>_<module>_<name>` (diff of the migrations, applied to a
   throwaway database, against the schema), then `npm run policies -w @nexus/factory-db -- <YYYYMMDDHHmm>_<module>_policies`
   (a later timestamp). Folder names: `<timestamp>_<module>_<name>`, so `_core` gives `…__core_…`.
3. Run the schema checks above and the PostgreSQL tests; the isolation tests cover a new table by themselves.
4. Merging (the lead, under the schema token, plan §2.1): merge `origin/main`, delete the branch's GENERATED migration
   folders, re-run step 2 with new timestamps, re-run the checks, merge, release the token. The hand-written folders
   (`…_audit_append_only`, `…_numbering_guards`, `…_outbox_guard`, `…_integration_guards`, `…_files_guards`,
   `…_links_guards`, `…_threads_guards`, `…_print_guards`, `…_parties_guards`, `…_email_guards`: triggers) are not
   regenerated: `git mv` the branch's one, unchanged, to a timestamp between its new schema and policy folders; keep it out of
   `prisma/migrations` while `npm run migration` runs (it replays every folder, and the triggers need the new table).
   The policy folder is always the last migration.

## Rules
- Run the Prisma CLI only from this folder. `prisma.config.ts` reads only `packages/factory-db/.env`
  (`FACTORY_MIGRATION_DATABASE_URL`, else `FACTORY_DATABASE_URL`; the process environment wins) and refuses a
  non-loopback database off Railway. `prisma migrate diff` needs a datasource even with `--from-empty`.
- Every model is classified (`check-ownership`): kind `tenant` (a `tenantId` column with the standard default, which
  the app never sets) or `platform`. An unclassified model gets no grant and no policy.
- The policies are generated, never hand-written: each policy migration holds the whole generated SQL, and the newest
  one must be the last migration and equal the generator (`check-policy-parity`).
- The history replays from zero, unlike Commerce (`check-migrations-replay`). Never `prisma migrate reset`,
  `prisma db push` or `prisma migrate dev` against a shared database.
- References inside a tenant include `tenantId` (and `siteId` between rows of one site): foreign-key checks skip
  row-level security, these keys do not let a row point at another tenant's row.
- The roles are cluster-wide and shared by every worktree on the local server: tests never drop or alter them; a test
  role gets a random name and is dropped. Migrations take the advisory lock in `src/testing/database.ts`.
- Seeds (`seed/<module>.ts`, run in name order) hold made-up data only and write through the scoped client.
- Every generator has an `output` inside this package (`check-prisma-output`). No `Float` (`check-no-float`): amounts
  are Int minor units, unit prices and costs Decimal(18,6), quantities Decimal(18,4).
- Never hand-edit `src/generated/` or a policy migration.
