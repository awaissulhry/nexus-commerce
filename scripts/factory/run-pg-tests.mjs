#!/usr/bin/env node
/**
 * run-pg-tests — RULE: the factory's real-PostgreSQL tests run on a loopback PostgreSQL 17, each test file in its own
 * throwaway database built from the migrations, and nothing of the run stays on the server.
 *
 *   1. The server is FACTORY_PG_TEST_SERVER_URL (shell only, never a `.env`), else the local factory stack at
 *      127.0.0.1:5442. It must be loopback and run PostgreSQL 17 or newer.
 *   2. Finds every `*.pg.vitest.test.ts` under src/ of the factory workspaces, keeps those whose path contains one of
 *      the arguments (all without arguments), and runs vitest on them in each workspace, with FACTORY_PG_TEST_RUN set
 *      to a fresh id. Each file makes its own database (factory-db's migratedDatabase: factory_test_<run>_…, from
 *      the migrations; db-kit's tests: factory_test_dbkit_…) and drops it.
 *   3. Afterwards drops every factory_test_<run>_… database this run left behind (a crashed file), and only those:
 *      other worktrees share the server.
 *
 * Run: node scripts/factory/run-pg-tests.mjs [filter …]   e.g. `isolation`, `packages/factory-db` — exit 1 when a test
 * fails, no file matches, or the server is not usable.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { tsImport } from 'tsx/esm/api'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKSPACES = ['packages/db-kit', 'packages/factory-db', 'packages/factory-domain', 'apps/factory-api', 'apps/factory-web']
const VITEST = join(ROOT, 'node_modules/.bin/vitest')
const posix = (path) => path.split(sep).join('/')

const { testServerUrl } = await tsImport('../../packages/factory-db/src/testing/database.ts', import.meta.url)

function testFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return ['node_modules', 'generated', 'dist'].includes(entry.name) ? [] : testFiles(path)
    return entry.name.endsWith('.pg.vitest.test.ts') ? [path] : []
  })
}

const filters = process.argv.slice(2)
const plan = WORKSPACES.map((workspace) => {
  const files = testFiles(join(ROOT, workspace, 'src'))
    .map((file) => posix(relative(ROOT, file)))
    .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
  return { workspace, files }
}).filter((entry) => entry.files.length > 0)

if (plan.length === 0) {
  console.error(`run-pg-tests: no *.pg.vitest.test.ts file matches ${filters.length > 0 ? filters.join(', ') : 'anything'}`)
  process.exit(1)
}

const server = testServerUrl()
const run = randomBytes(4).toString('hex')
const root = new pg.Client({ connectionString: server.href })
await root.connect()
let failed = false
try {
  const version = (await root.query('SHOW server_version')).rows[0].server_version
  if (!/^1[7-9]\.|^[2-9]\d\./.test(version)) throw new Error(`the server runs PostgreSQL ${version}; the factory needs 17`)
  console.log(`run-pg-tests: run ${run} on PostgreSQL ${version} at ${server.host}`)
  for (const { workspace, files } of plan) {
    console.log(`\nrun-pg-tests: ${workspace} (${files.length} file(s))`)
    const local = files.map((file) => posix(relative(workspace, file)))
    const result = spawnSync(VITEST, ['run', ...local], {
      cwd: join(ROOT, workspace),
      stdio: 'inherit',
      env: { ...process.env, FACTORY_PG_TEST_RUN: run },
    })
    if (result.status !== 0) failed = true
  }
} catch (error) {
  console.error(`run-pg-tests: ${error.message}`)
  failed = true
} finally {
  const left = (await root.query("SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY 1", [`factory_test_${run}_`])).rows
  for (const { datname } of left) await root.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  if (left.length > 0) console.log(`run-pg-tests: dropped ${left.length} database(s) a test left behind`)
  await root.end()
}
console.log(`\nrun-pg-tests: ${failed ? 'FAILED' : 'all passed'}`)
process.exit(failed ? 1 : 0)
