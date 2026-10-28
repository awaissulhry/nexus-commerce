#!/usr/bin/env node
/**
 * check-migrations-replay — RULE: the factory's migration history replays from zero (unlike Commerce's) and gives
 * exactly the Prisma schema, with every table behind forced row-level security.
 *
 *   1. Creates a throwaway database factory_test_replay_<hex> on a loopback PostgreSQL 17: FACTORY_PG_TEST_SERVER_URL
 *      (shell only), else the local factory stack at 127.0.0.1:5442. Anything else stops the check before it connects.
 *   2. `prisma migrate deploy` applies packages/factory-db/prisma/migrations to it, from packages/factory-db, with
 *      FACTORY_MIGRATION_DATABASE_URL pointing at it (never a `.env`).
 *   3. `prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code` must find no difference.
 *   4. Every table (except _prisma_migrations) has row-level security enabled AND forced.
 *   5. Drops the database, whatever happened.
 *
 * Needs the local PostgreSQL, so run-guards.mjs does not run it; it is a schema check (`npm run check:drift -w
 * @nexus/factory-db` runs it too). The migrations create the cluster-wide roles under the same advisory lock the test
 * databases use (packages/factory-db/src/testing/database.ts).
 *
 * Run: node scripts/factory/check-migrations-replay.mjs — exit 1 on any problem.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { tsImport } from 'tsx/esm/api'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PACKAGE = join(ROOT, 'packages/factory-db')
const PRISMA = join(ROOT, 'node_modules/.bin/prisma')

const testing = await tsImport('../../packages/factory-db/src/testing/database.ts', import.meta.url)
const { readMigrations } = await tsImport('../../packages/factory-db/src/policies.ts', import.meta.url)
const { MIGRATIONS_DIR } = await tsImport('../../packages/factory-db/src/tools.ts', import.meta.url)

const fail = (message) => {
  console.error(`check-migrations-replay: ${message}`)
  process.exitCode = 1
}

const server = testing.testServerUrl()
const name = `factory_test_replay_${randomBytes(4).toString('hex')}`
const url = new URL(server.href)
url.pathname = `/${name}`
const prisma = (args) =>
  spawnSync(PRISMA, args, {
    cwd: PACKAGE,
    encoding: 'utf8',
    env: { ...process.env, FACTORY_MIGRATION_DATABASE_URL: url.href, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  })
const output = (run) => `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}`.trim().replace(/^/gm, '    ')

const root = new pg.Client({ connectionString: server.href })
await root.connect()
try {
  const version = (await root.query('SHOW server_version')).rows[0].server_version
  if (!/^1[7-9]\.|^[2-9]\d\./.test(version)) throw new Error(`the server runs PostgreSQL ${version}; the factory needs 17`)
  await root.query(`CREATE DATABASE "${name}"`)
  try {
    const migrations = readMigrations(MIGRATIONS_DIR)
    await root.query('SELECT pg_advisory_lock($1::bigint)', [testing.MIGRATION_LOCK])
    let deploy
    try {
      deploy = prisma(['migrate', 'deploy'])
    } finally {
      await root.query('SELECT pg_advisory_unlock($1::bigint)', [testing.MIGRATION_LOCK])
    }
    if (deploy.status !== 0) throw new Error(`prisma migrate deploy failed:\n${output(deploy)}`)

    const diff = prisma(['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema', '--script', '--exit-code'])
    if (diff.status === 2) throw new Error(`the replayed database differs from prisma/schema; the missing migration is:\n${output(diff)}`)
    if (diff.status !== 0) throw new Error(`prisma migrate diff failed:\n${output(diff)}`)

    const db = new pg.Client({ connectionString: url.href })
    await db.connect()
    let tables
    try {
      tables = (
        await db.query(`SELECT relname, relrowsecurity AND relforcerowsecurity AS walled FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> '_prisma_migrations' ORDER BY relname`)
      ).rows
    } finally {
      await db.end()
    }
    const open = tables.filter((table) => !table.walled).map((table) => table.relname)
    if (open.length > 0) throw new Error(`table(s) without enabled and forced row-level security: ${open.join(', ')}`)
    console.log(
      `check-migrations-replay: ok (${migrations.length} migration(s) replayed from zero on PostgreSQL ${version}; ` +
        `no difference from prisma/schema; ${tables.length} table(s), all behind forced row-level security)`,
    )
  } finally {
    await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  }
} catch (error) {
  fail(error.message)
} finally {
  await root.end()
}
