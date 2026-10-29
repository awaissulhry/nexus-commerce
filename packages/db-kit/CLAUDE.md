# packages/db-kit — generic database tools for the factory

Generic and fail closed: no factory names inside, roles and setting names are parameters. Extracted from Commerce's
`packages/database` (`workspace-adapter.ts`, `runtime-role.ts`, `workspace-sql.ts`, `scripts/workspace-policies.mjs`);
Commerce keeps its own copy unchanged and nothing in Commerce imports this package.

## What it offers (all from `@nexus/db-kit`)
- `url-guard.ts`: `isLoopbackUrl`, `isLoopbackHost`, `describeUrlHost`. Used by the factory env loaders and tests.
- `scope.ts`: a `ScopeDefinition` (the role, and keyed settings each `required` or not) and `makeScope`, which checks
  values against it. Missing required value, unknown key or bad name → `TenantScopeError`. No fallback scope.
- `tenant-adapter.ts`: `TenantPg`, the Prisma 7 driver adapter (`new PrismaClient({ adapter: new TenantPg(pool,
  definition, values) })`). Every statement runs in a transaction that first runs ONE bound statement:
  `SELECT set_config($1, $2, true), …` (the role, then every setting). A statement outside a transaction gets its own
  (BEGIN, scope, statement, COMMIT). `executeScript` is refused.
  - The scope is FIXED per adapter: one PrismaClient per scope, never one client for two scopes (Prisma batches reads
    of one client). The per-scope client cache belongs to `@nexus/factory-db`. Each client adds an error listener to
    the shared pool, so that cache raises `pool.setMaxListeners` (Commerce's router does the same).
- `sql-guard.ts`: `checkStatement`, run by the adapter on EVERY statement, Prisma's own included. It allows one
  SELECT, INSERT, UPDATE, DELETE or WITH. It refuses SET/RESET/DO/DDL, a second statement, `$` other than `$n`, `U&`,
  `SELECT … INTO`, and names that change settings or run SQL from a string (`set_config`, `pg_settings`,
  `query_to_xml…`, `ts_stat`, `ts_rewrite`, `lo_*`, `dblink`). Bare COMMIT/ROLLBACK pass only inside a transaction (the
  engine sends them). After them, nothing more runs on that transaction.
- `runtime-role.ts`: `auditRuntimeRole(client, { roles, inherit?, setConfigLocked? })` refuses a login that (itself or
  through any reachable role) is superuser / BYPASSRLS / CREATEROLE / CREATEDB / REPLICATION / `pg_*`. It also refuses
  one that owns the database or any application schema, table, function or type, may CREATE, holds
  TRUNCATE/REFERENCES/TRIGGER, or holds ADMIN OPTION. It requires that the login can SET every runtime role. It lists
  every failed check. `AuditedPool` audits each physical connection once before pg or Prisma borrows it.
- `policy-sql.ts` (also `@nexus/db-kit/policy-sql`, pure):
  - `policySql(model)` and `tablePolicySql(model, table)` write idempotent, sorted SQL: ENABLE + FORCE RLS, one
    policy per role and command on `current_setting('<setting>', true)` (empty → no row), and grants. A role with
    hidden columns gets column grants that leave them out; a role with `onlyValues` (column → listed values) reaches
    only the rows whose column holds one of them (`"kind"::text IN (…)` in every policy of that role).
  - The generator owns every policy on a managed table: it drops unknown ones and revokes all from PUBLIC and every
    managed role before granting.
  - `runtimeRoleSql(roles)` creates NOLOGIN runtime roles.
  - `lockSetConfigSql(logins, runtimeRoles)` lets only the logins run `set_config`. That is the database wall behind
    the statement guard; the adapter still works.

## Commands
    npm run typecheck -w @nexus/db-kit
    cd packages/db-kit && npx vitest run                         # pure + real PostgreSQL, about 3 s
    cd packages/db-kit && npx vitest run src/sql-guard.vitest.test.ts

## Tests
- `*.pg.vitest.test.ts` need the local factory stack: PostgreSQL 17 on 127.0.0.1:5442, or a loopback server named by
  `FACTORY_DB_KIT_TEST_SERVER_URL` (shell only). Each file creates `factory_test_dbkit_<label>_<hex>` and random
  `dbkit_<hex>_*` roles, then drops all of them. The server is shared with other worktrees, so never name a fixed role
  and never alter a role you did not create.
- The Prisma client in the tests is the repository's default generated `@prisma/client` (Commerce's). Tests use it
  only through raw SQL or untyped delegates; db-kit has no schema of its own.

## Rules
- Exports TypeScript source (`exports` point at `src/*.ts`); there is no build step.
- No environment reading in library code: callers pass pools, roles, settings and URLs in. Only `src/testing/` reads
  `FACTORY_DB_KIT_TEST_SERVER_URL`.
- Never build SQL from a value. Scope values are bound parameters. The generator emits only names that passed its
  identifier checks.
- Keep `checkStatement` an allow-list. Before you allow a new statement shape, add the refusals around it to
  `sql-guard.vitest.test.ts` and keep `prisma-sql.vitest.test.ts` passing.
