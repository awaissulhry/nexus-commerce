#!/usr/bin/env node
/**
 * AE.1 + AE.3 — run the tests that need a REAL, multi-connection PostgreSQL, for the pre-push hook.
 *
 * WHY A REAL SERVER
 * The normal test database (PGlite behind one connection) queues every transaction. Two things cannot
 * be tested there:
 *   · `stock-concurrency.vitest.test.ts` (AE.1) — simultaneous stock writes lose nothing. A race cannot
 *     happen on one connection, so the test would pass whether or not the code is safe.
 *   · `copy-run.vitest.test.ts` (AE.3, R-AE-16) — a first copy end to end through the real catalog
 *     transfer engine, whose apply holds a transaction while it checkpoints on a second connection.
 * Both therefore SKIP unless given a multi-connection server, which means a normal suite run verifies
 * nothing. This script supplies one.
 *
 * WHAT IT DOES
 *   1. Docker unavailable, or no PostgreSQL 17 image on this machine → prints a named SKIP and exits 0.
 *      It never pulls an image during a push.
 *   2. Starts ONE container on a random 127.0.0.1 port, data on tmpfs, removed on exit (also on Ctrl-C).
 *      Each test file creates and drops its own randomly named database in it. The files run ONE AFTER
 *      ANOTHER: each applies the generated policies, which create a server-wide role, and two files doing
 *      that at once fail with "duplicate key value violates unique constraint pg_authid_rolname_index"
 *      (measured 2026-09-17: the second suite then skipped every test).
 *   3. Runs the suites with that server. DATABASE_URL points at a dead port, so no un-mocked client can
 *      reach a shared database, and REDIS_URL too, because apps/api/.env names a production Redis.
 *   4. Exit 0 only if vitest exits 0 AND, for EVERY suite, its own file reports exactly the expected
 *      number of passed tests, none skipped and none failed. Counts are read per file from vitest's JSON
 *      report, so one suite's passes can never cover for another's skips. A suite that skipped measured
 *      nothing: that is a failure here, not a pass.
 *
 *   node scripts/run-real-postgres-tests.mjs
 *   node scripts/run-real-postgres-tests.mjs --suites '[{"name":"x","file":"src/…","expect":1}]'   # harness use
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = `${ROOT}/apps/api`
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const SUITES = flag('--suites') ? JSON.parse(flag('--suites')) : [
  { name: 'stock race test (AE.1)', file: 'src/services/stock-concurrency.vitest.test.ts', expect: 10 },
  { name: 'assortment copy test (AE.3)', file: 'src/services/assortment/copy-run.vitest.test.ts', expect: 8 },
]
const IMAGES = ['pgvector/pgvector:pg17', 'postgres:17', 'postgres:17-alpine']
const DEAD = 'postgresql://nobody@127.0.0.1:1/real_pg_no_stray_writes_test'

const docker = (...cmd) => execFileSync('docker', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim()

function skip(reason) {
  console.log(`⚠ real-PostgreSQL tests SKIPPED — ${reason}. They prove no stock update is lost under concurrency and that a shared-product copy completes end to end; run them where Docker is available.`)
  process.exit(0)
}

try { docker('info', '--format', '{{.ServerVersion}}') } catch { skip('Docker is not available here') }
const image = IMAGES.find((name) => { try { docker('image', 'inspect', name); return true } catch { return false } })
if (!image) skip(`no PostgreSQL 17 image on this machine (docker pull ${IMAGES[0]})`)

const name = `nexus-real-pg-${process.pid}`
const reportDir = mkdtempSync(join(tmpdir(), 'nexus-real-pg-'))
let started = false
const stop = () => {
  if (started) {
    started = false
    try { docker('stop', name) } catch { /* already gone */ }
  }
  rmSync(reportDir, { recursive: true, force: true })
}
process.on('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(130) })

try {
  docker('run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '--tmpfs', '/var/lib/postgresql/data', image)
  started = true
  const port = docker('port', name, '5432/tcp').split('\n')[0].split(':').pop()
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    try { docker('exec', name, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'); ready = true } catch { spawnSync('sleep', ['0.5']) }
  }
  if (!ready) { console.error('❌ real-PostgreSQL tests: the throwaway PostgreSQL did not become ready in 30 s'); process.exit(1) }

  const reportPath = join(reportDir, 'report.json')
  const run = spawnSync('npx', ['vitest', 'run', ...SUITES.map((suite) => suite.file), '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`], {
    cwd: API,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEXUS_TEST_CONCURRENT_PG_URL: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      DATABASE_URL: DEAD,
      DIRECT_URL: DEAD,
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  let report = null
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) } catch { /* judged below as "no report" */ }

  const verdicts = SUITES.map((suite) => {
    const file = report?.testResults?.find((result) => resolve(result.name) === resolve(API, suite.file))
    const statuses = file?.assertionResults?.map((test) => test.status) ?? []
    const count = (status) => statuses.filter((s) => s === status).length
    const passed = count('passed'), failed = count('failed'), skipped = statuses.length - passed - failed
    const ok = !!file && passed === suite.expect && failed === 0 && skipped === 0
    const detail = file ? `${passed} passed, ${failed} failed, ${skipped} skipped` : 'not in the report'
    return { suite, ok, line: `${suite.name}: ${detail} (expected ${suite.expect} passed)` }
  })

  if (run.status === 0 && report && verdicts.every((v) => v.ok)) {
    for (const v of verdicts) console.log(`✓ ${v.line}`)
    console.log(`✓ real-PostgreSQL tests passed (throwaway PostgreSQL, ${image})`)
    process.exit(0)
  }
  console.error(`❌ real-PostgreSQL tests FAILED — vitest exit ${run.status}${report ? '' : '; no JSON report was written'}`)
  for (const v of verdicts) console.error(`${v.ok ? '  ✓' : '  ✗'} ${v.line}`)
  console.error(output.split('\n').filter((l) => /FAIL|AssertionError|Error:|expected|skipped/.test(l)).slice(0, 40).join('\n'))
  process.exit(1)
} finally {
  stop()
}
