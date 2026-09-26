/**
 * PLAN Step 0.4 — the baseline must build the schema `schema.prisma` describes.
 *
 * THE RISK THIS GUARDS. `prisma/baseline.sql` is how a FRESH database is built, because the
 * 467-migration history does not replay (443 apply, 24 fail — ordering, not missing migrations).
 * A baseline that has drifted from `schema.prisma` would stand databases up with the wrong schema,
 * silently, and every fixture built on them would be measuring the wrong thing.
 *
 * 🔴 WHY THE ASSERTION IS NOT "the diff is empty". It cannot be, and finding that out is the
 * reason this file reads the DATABASE rather than believing the tool.
 *
 *   `@default(dbgenerated("NULLIF(current_setting('nexus.workspace_id', true), '')"))` is applied
 *   correctly — measured on a database built from this baseline, the column default really is
 *   `NULLIF(current_setting('nexus.workspace_id'::text, true), ''::text)`. Postgres normalises the
 *   expression with `::text` casts, and `prisma migrate diff` does not recognise it as its own. So
 *   it reports the same 420 `SET DEFAULT` statements FOREVER, on a database that already has them.
 *
 * So the gate says what is actually true: the residual diff may contain those defaults and
 * NOTHING else. Any other statement is real drift and fails. A weaker "diff is empty" assertion
 * could never have gone green; a "table names match" assertion would have passed while a column
 * type or an index differed.
 *
 * 🔴 DATABASE TARGET. A throwaway database on the LOCAL Postgres, created and dropped here. The
 * host is asserted to be loopback before anything is written. Production is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')

// CI names its disposable server in NEXUS_TEST_LOCAL_PG_URL (docs/ci-plan.md §2.3); a developer machine
// falls back to apps/api/.env. A missing file is "no local database", not a crash at load.
const envFile = join(repoRoot, 'apps/api/.env')
const localUrl = process.env.NEXUS_TEST_LOCAL_PG_URL?.trim()
  || (existsSync(envFile) ? readFileSync(envFile, 'utf8').match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() : undefined)
const host = localUrl ? new URL(localUrl).hostname : ''
const isLoopback = host === '127.0.0.1' || host === 'localhost'
const canRun = Boolean(localUrl) && isLoopback

const DB = `nexus_baseline_check_${process.pid}`
const adminUrl = localUrl ? `${localUrl.slice(0, localUrl.lastIndexOf('/'))}/postgres` : ''
const targetUrl = localUrl ? `${localUrl.slice(0, localUrl.lastIndexOf('/'))}/${DB}` : ''

async function admin(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl })
  await c.connect(); await c.query(sql); await c.end()
}

/** The one class of statement Prisma cannot round-trip. Anything else in the residual is drift. */
const UNREPRESENTABLE = /^ALTER TABLE "[^"]+" ALTER COLUMN "workspaceId" SET DEFAULT NULLIF\(current_setting\('nexus\.workspace_id', true\), ''\);$/

describe.runIf(canRun)('prisma/baseline.sql', () => {
  let residual = ''
  let tables = 0
  let defaults = 0

  beforeAll(async () => {
    expect(isLoopback, `refusing a non-loopback target: ${host}`).toBe(true)
    await admin(`DROP DATABASE IF EXISTS "${DB}"`)
    await admin(`CREATE DATABASE "${DB}"`)

    const client = new pg.Client({ connectionString: targetUrl })
    await client.connect()
    await client.query(readFileSync(join(pkgRoot, 'prisma', 'baseline.sql'), 'utf8'))
    tables = (await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    )).rows[0].n
    defaults = (await client.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'workspaceId' AND column_default IS NOT NULL`,
    )).rows[0].n
    await client.end()

    residual = execFileSync('npx', [
      'prisma', 'migrate', 'diff',
      '--from-config-datasource',
      '--to-schema', 'prisma/schema.prisma',
      '--script',
    ], { cwd: pkgRoot, env: { ...process.env, DATABASE_URL: targetUrl, MIGRATION_DATABASE_URL: targetUrl }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  }, 600_000)

  afterAll(async () => { if (canRun) await admin(`DROP DATABASE IF EXISTS "${DB}"`) }, 60_000)

  it('positive control — the baseline really built a schema', () => {
    expect(tables).toBeGreaterThan(400)
  })

  it('🔴 the workspaceId defaults ARE applied — measured in the database, not asked of Prisma', () => {
    // `prisma migrate diff` reports these as missing on a database that has them, because Postgres
    // stores the expression normalised with `::text` casts. An earlier version of the generator
    // believed that report and appended 420 duplicate ALTER statements. information_schema settles
    // it: the defaults are emitted inline by `CREATE TABLE` and are really there.
    expect(defaults).toBeGreaterThan(400)
  })

  it('🔴 the residual diff contains NOTHING but those defaults — anything else is real drift', () => {
    const statements = residual
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('--'))
    const unexpected = statements.filter(line => !UNREPRESENTABLE.test(line))
    expect(unexpected, `unexpected drift:\n${unexpected.slice(0, 10).join('\n')}`).toEqual([])
    // And the known ones must still be the only thing there, not zero of everything.
    expect(statements.length).toBeGreaterThan(400)
  })
})

/**
 * A-13 (ruled 2026-09-22, option a) — a database built by `bootstrap-fresh-database.mjs` must be
 * ISOLATED, not merely schema-correct.
 *
 * 🔴 WHAT THIS GUARDS, measured before the fix. `baseline.sql` is a pure `schema.prisma` dump and
 * holds 0 `CREATE POLICY`, 0 `ROW LEVEL SECURITY` and 0 `GRANT`, because a schema cannot express a
 * policy. The bootstrap therefore produced a database with **0 policies against production's 444**
 * and no grants for `nexus_workspace_runtime` — the role `workspace-adapter.js:11` switches to on
 * every query. The application died with `permission denied for table Product`, which is the loud
 * failure and the safe one. The dangerous case was fixing THAT by adding the grants alone: the app
 * then runs perfectly with every business reading every other business's rows.
 *
 * 🔴 The tests above could not have caught it. They assert the SCHEMA matches `schema.prisma`.
 * They never connect the application and never count a policy. A gate measures what the step
 * built, never what it left out — so the omission needs its own gate.
 */
describe.runIf(canRun)('bootstrap-fresh-database.mjs — isolation, not just schema', () => {
  const BOOT = `nexus_bootstrap_check_${process.pid}`
  const bootUrl = localUrl ? `${localUrl.slice(0, localUrl.lastIndexOf('/'))}/${BOOT}` : ''
  let counts = { policies: 0, rls: 0, grants: 0, workspaces: 0, deployedColumn: 0 }

  beforeAll(async () => {
    expect(isLoopback, `refusing a non-loopback target: ${host}`).toBe(true)
    await admin(`DROP DATABASE IF EXISTS "${BOOT}"`)
    await admin(`CREATE DATABASE "${BOOT}"`)
    execFileSync('node', [join(pkgRoot, 'scripts', 'bootstrap-fresh-database.mjs')], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL: bootUrl }, maxBuffer: 16 * 1024 * 1024,
    })
    const c = new pg.Client({ connectionString: bootUrl })
    await c.connect()
    counts = (await c.query(`
      SELECT (SELECT count(*)::int FROM pg_policies) AS policies,
             (SELECT count(*)::int FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
               WHERE n.nspname = 'public' AND cl.relrowsecurity) AS rls,
             (SELECT count(*)::int FROM information_schema.role_table_grants
               WHERE grantee = 'nexus_workspace_runtime') AS grants,
             (SELECT count(*)::int FROM "Workspace" WHERE status = 'active') AS workspaces,
             (SELECT count(*)::int FROM information_schema.columns
               WHERE table_name = 'ChannelListing' AND column_name = 'variationExcluded') AS "deployedColumn"`)).rows[0]
    await c.end()
  }, 600_000)

  afterAll(async () => { if (canRun) await admin(`DROP DATABASE IF EXISTS "${BOOT}"`) }, 60_000)

  it('🔴 every business-owned table carries a row-level-security policy', () => {
    // Not "> 0": a single stray policy would pass that. The isolation layer covers hundreds of
    // tables, and a count that collapses is the failure this guards.
    expect(counts.policies).toBeGreaterThan(400)
    expect(counts.rls).toBeGreaterThan(400)
  })

  it('🔴 the runtime role can actually reach the tables — a policy with no GRANT is a dead database', () => {
    expect(counts.grants).toBeGreaterThan(400)
  })

  it('🔴 an ACTIVE Workspace row exists — the policy reads it, so without one every legacy row is invisible', () => {
    expect(counts.workspaces).toBeGreaterThan(0)
  })

  it('carries the deployed-only column the disposable test database also adds', () => {
    expect(counts.deployedColumn).toBe(1)
  })
})
