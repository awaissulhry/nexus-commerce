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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')

const localUrl = readFileSync(join(repoRoot, 'apps/api/.env'), 'utf8').match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim()
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
      '--from-url', targetUrl,
      '--to-schema-datamodel', 'prisma/schema.prisma',
      '--script',
    ], { cwd: pkgRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
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
