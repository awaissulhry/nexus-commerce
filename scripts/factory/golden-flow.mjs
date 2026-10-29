#!/usr/bin/env node
/**
 * golden-flow — RULE: the API golden flow (B-W1-06a: the first real order, a brand size run, from the customer to the
 * paid invoice) passes end to end THROUGH THE HTTP ROUTES on a loopback PostgreSQL 17, in a throwaway database built
 * from the migrations, with every provider FAKE (VIES, SES, R2, SDI, Sendcloud, print relay), and nothing of the run
 * stays on the server.
 *
 *   1. The server is FACTORY_PG_TEST_SERVER_URL (shell only, never a `.env`), else the local factory stack at
 *      127.0.0.1:5442. It must be loopback and run PostgreSQL 17 or newer (the same rules as run-pg-tests.mjs).
 *   2. Runs vitest on apps/factory-api/src/golden-flow/ with FACTORY_PG_TEST_RUN set to a fresh id: the file makes its
 *      own database (factory-db's migratedDatabase: factory_test_<run>_golden_…), seeds the base seeds into it and
 *      drops it. Each step of the flow is one test, in order; a step another lane still has to make reachable is an
 *      `it.todo` naming the reason.
 *   3. Prints the steps passed / todo / failed, then drops every factory_test_<run>_… database this run left behind
 *      (a crashed file), and only those: other worktrees share the server.
 *
 * Run: node scripts/factory/golden-flow.mjs — exit 1 when a step fails or the server is not usable. The vitest database
 * guard needs FACTORY_DATABASE_URL (loopback, factory_test… or this worktree's database) on the command line when the
 * worktree has no apps/factory-api/.env.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { tsImport } from 'tsx/esm/api'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKSPACE = join(ROOT, 'apps/factory-api')
const FOLDER = 'src/golden-flow/'
const VITEST = join(ROOT, 'node_modules/.bin/vitest')

const { testServerUrl } = await tsImport('../../packages/factory-db/src/testing/database.ts', import.meta.url)

if (!existsSync(join(WORKSPACE, FOLDER))) {
  console.error(`golden-flow: ${FOLDER} is missing in apps/factory-api`)
  process.exit(1)
}

const server = testServerUrl()
const run = randomBytes(4).toString('hex')
const root = new pg.Client({ connectionString: server.href })
await root.connect()
const reportDir = mkdtempSync(join(tmpdir(), 'factory-golden-flow-'))
const reportFile = join(reportDir, 'report.json')
let failed = false
try {
  const version = (await root.query('SHOW server_version')).rows[0].server_version
  if (!/^1[7-9]\.|^[2-9]\d\./.test(version)) throw new Error(`the server runs PostgreSQL ${version}; the factory needs 17`)
  console.log(`golden-flow: run ${run} on PostgreSQL ${version} at ${server.host}\n`)
  const result = spawnSync(VITEST, ['run', FOLDER, '--reporter=verbose', '--reporter=json', `--outputFile.json=${reportFile}`], {
    cwd: WORKSPACE,
    stdio: 'inherit',
    env: { ...process.env, FACTORY_PG_TEST_RUN: run },
  })
  if (result.status !== 0) failed = true
  if (existsSync(reportFile)) {
    const report = JSON.parse(readFileSync(reportFile, 'utf8'))
    const steps = report.testResults.flatMap((file) => file.assertionResults)
    const count = (status) => steps.filter((step) => step.status === status).length
    console.log(`\ngolden-flow: ${steps.length} step(s): ${count('passed')} passed, ${count('todo')} todo, ${count('failed')} failed, ${count('skipped') + count('pending')} skipped`)
    for (const step of steps.filter((entry) => entry.status === 'todo')) console.log(`  todo  ${step.title}`)
    for (const step of steps.filter((entry) => entry.status === 'failed')) console.log(`  FAIL  ${step.title}`)
  }
} catch (error) {
  console.error(`golden-flow: ${error.message}`)
  failed = true
} finally {
  rmSync(reportDir, { recursive: true, force: true })
  const left = (await root.query('SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY 1', [`factory_test_${run}_`])).rows
  for (const { datname } of left) await root.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  if (left.length > 0) console.log(`golden-flow: dropped ${left.length} database(s) the run left behind`)
  await root.end()
}
console.log(`\ngolden-flow: ${failed ? 'FAILED' : 'passed'}`)
process.exit(failed ? 1 : 0)
