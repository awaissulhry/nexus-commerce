#!/usr/bin/env node
/**
 * PLAN Step 0.4 — stand a FRESH database up from `prisma/baseline.sql`, then mark the whole
 * migration history as already applied.
 *
 * This is Prisma's documented "baseline an existing database" shape, used here because the
 * 467-migration history does not replay from zero (443 apply, 24 fail — an ordering problem, not
 * missing migrations; see generate-baseline.mjs for why renaming the folders is not an option).
 *
 * AFTER THIS RUNS the database is in the same state as production: the schema is what
 * `schema.prisma` says, `_prisma_migrations` holds all 467 names, and the BUSINESS ISOLATION
 * LAYER is in place, so the NEXT `prisma migrate deploy` applies only genuinely new migrations.
 * Nothing special happens from then on.
 *
 * 🔴 WHY STEP 3 EXISTS (A-13, ruled 2026-09-22). `baseline.sql` is a pure `schema.prisma` dump:
 * **0 `CREATE POLICY`, 0 `ROW LEVEL SECURITY`, 0 `GRANT`** — a schema cannot express a policy.
 * Without step 3 this script produced a database with **0 policies against production's 444** and
 * no grants for `nexus_workspace_runtime`, the role `workspace-adapter.js:11` switches to on every
 * query. The application then died with `permission denied for table Product` — the LOUD failure,
 * and the safe one. The dangerous case was someone fixing that by adding the grants alone: the app
 * would run perfectly with **every business able to read every other business's rows**. The
 * failure was one `GRANT` away from silent.
 *
 * 🔴 SAFETY. It refuses any target that is not loopback, and refuses a database that already has
 * tables or migration rows. It is a bootstrap, never a repair: it will not touch a database that
 * has anything in it. The refusal names what it saw.
 *
 *   DATABASE_URL=postgres://…/nexus_scale node packages/database/scripts/bootstrap-fresh-database.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { workspacePolicySql } from './workspace-policies.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const baselinePath = join(pkgRoot, 'prisma', 'baseline.sql')
const migrationsDir = join(pkgRoot, 'prisma', 'migrations')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[bootstrap] DATABASE_URL is not set')
  process.exit(1)
}
const parsed = new URL(url)
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
  console.error(`\n❌ REFUSED: bootstrap target is not local — host "${parsed.hostname}".`)
  console.error('   This writes a whole schema. It is for a fresh local or CI database only.\n')
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
const db = (await client.query('SELECT current_database() AS d')).rows[0].d
console.log(`[bootstrap] host ${parsed.hostname}:${parsed.port}  database ${db}`)

const existing = await client.query(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
)
if (existing.rows[0].n > 0) {
  console.error(`\n❌ REFUSED: "${db}" already has ${existing.rows[0].n} tables in public.`)
  console.error('   This is a bootstrap, not a repair. Use an empty database.\n')
  await client.end()
  process.exit(1)
}

// ── 1. the schema ─────────────────────────────────────────────────
const baseline = readFileSync(baselinePath, 'utf8')
await client.query(baseline)
const tables = await client.query(
  `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
)
console.log(`[bootstrap] baseline applied — ${tables.rows[0].n} tables`)

// ── 2. the history, marked applied ────────────────────────────────
//
// Ordered by localeCompare, which is how Prisma orders them — pinned against an observed deploy,
// not assumed (see replay-migrations.mjs). The checksum is Prisma's: sha256 of the migration SQL.
const folders = readdirSync(migrationsDir)
  .filter((entry) => {
    try { return statSync(join(migrationsDir, entry)).isDirectory() } catch { return false }
  })
  .sort((a, b) => a.localeCompare(b))

await client.query(`
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id                      VARCHAR(36)  PRIMARY KEY NOT NULL,
    checksum                VARCHAR(64)  NOT NULL,
    finished_at             TIMESTAMPTZ,
    migration_name          VARCHAR(255) NOT NULL,
    logs                    TEXT,
    rolled_back_at          TIMESTAMPTZ,
    started_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    applied_steps_count     INTEGER      NOT NULL DEFAULT 0
  )`)

let stamped = 0
for (const folder of folders) {
  let sql = ''
  try { sql = readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8') } catch { /* folder with no SQL */ }
  const checksum = createHash('sha256').update(sql).digest('hex')
  await client.query(
    `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
     VALUES ($1, $2, now(), $3, now(), 1)`,
    [createHash('sha256').update(folder).digest('hex').slice(0, 36), checksum, folder],
  )
  stamped++
}
console.log(`[bootstrap] marked ${stamped} migrations as applied`)

// ── 3. the isolation layer ────────────────────────────────────────
//
// The same three statements, in the same order, that `apps/api/src/test-support/
// concurrent-database.ts:52-55` applies to a disposable test database. One generator, so a
// bootstrapped database and a test database cannot disagree about who may read what.
await client.query(
  `ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" boolean NOT NULL DEFAULT false`,
)
// The isolation policy reads `Workspace` and requires an ACTIVE row, so the legacy business has to
// exist before the policies do. Without it every legacy row is invisible to every reader.
await client.query(
  `INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
   VALUES ('nexus_legacy_workspace', 'Legacy business', 'active', true, 'bootstrap', 'bootstrap', CURRENT_TIMESTAMP)
   ON CONFLICT (id) DO NOTHING`,
)
await client.query(workspacePolicySql())

// 🔴 The gate, in the script itself. A-13's ruling: count the policies and refuse a zero. A
// bootstrap that silently produced an unisolated database is the whole reason this step exists,
// and a step that cannot fail is not a step.
const isolation = await client.query(`
  SELECT (SELECT count(*)::int FROM pg_policies) AS policies,
         (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relrowsecurity) AS rls,
         (SELECT count(*)::int FROM information_schema.role_table_grants
           WHERE grantee = 'nexus_workspace_runtime') AS grants`)
const { policies, rls, grants } = isolation.rows[0]
if (policies === 0 || rls === 0 || grants === 0) {
  console.error(`\n❌ REFUSED: the isolation layer did not land — ${policies} policies, ${rls} RLS tables, ${grants} grants.`)
  console.error('   A database with no policies is one GRANT away from every business reading every other business.\n')
  await client.end()
  process.exit(1)
}
console.log(`[bootstrap] isolation applied — ${policies} policies on ${rls} tables, ${grants} grants to nexus_workspace_runtime`)

console.log(`[bootstrap] ✓ "${db}" now matches schema.prisma, is isolated, and the next migrate deploy applies only new migrations`)
await client.end()
