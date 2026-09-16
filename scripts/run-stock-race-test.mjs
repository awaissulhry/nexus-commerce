#!/usr/bin/env node
/**
 * AE.1 — run the stock race test against a THROWAWAY PostgreSQL, for the pre-push hook.
 *
 * WHY A REAL SERVER
 * `apps/api/src/services/stock-concurrency.vitest.test.ts` proves that simultaneous stock writes
 * lose nothing. The normal test database (PGlite behind one connection) queues every transaction,
 * so a race cannot happen there and the test would pass whether or not the code is safe. The test
 * therefore SKIPS unless it is given a multi-connection server — which means a normal suite run
 * verifies nothing. This script supplies one.
 *
 * WHAT IT DOES
 *   1. Docker unavailable, or no PostgreSQL 17 image on this machine → prints a named SKIP and exits 0.
 *      It never pulls an image during a push.
 *   2. Starts a container on a random 127.0.0.1 port, data on tmpfs, removed on exit (also on Ctrl-C).
 *   3. Runs the test with that server, and with DATABASE_URL on a dead port so no un-mocked client can
 *      reach a shared database.
 *   4. Exit 0 only if vitest exits 0 AND reports the expected number of passed tests AND none skipped.
 *      A suite that skipped measured nothing, and that is a failure here, not a pass.
 *
 *   node scripts/run-stock-race-test.mjs
 *   node scripts/run-stock-race-test.mjs --config <vitest config> --expect <n>   # harness use
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const CONFIG = flag('--config')
const EXPECT = Number(flag('--expect') ?? 10)
const TEST_FILE = 'src/services/stock-concurrency.vitest.test.ts'
const IMAGES = ['pgvector/pgvector:pg17', 'postgres:17', 'postgres:17-alpine']

const docker = (...cmd) => execFileSync('docker', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim()

function skip(reason) {
  console.log(`⚠ stock race test SKIPPED — ${reason}. It proves no stock update is lost under concurrency; run it where Docker is available.`)
  process.exit(0)
}

try { docker('info', '--format', '{{.ServerVersion}}') } catch { skip('Docker is not available here') }
const image = IMAGES.find((name) => { try { docker('image', 'inspect', name); return true } catch { return false } })
if (!image) skip(`no PostgreSQL 17 image on this machine (docker pull ${IMAGES[0]})`)

const name = `nexus-stock-race-${process.pid}`
let started = false
const stop = () => {
  if (!started) return
  started = false
  try { docker('stop', name) } catch { /* already gone */ }
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
  if (!ready) { console.error('❌ stock race test: the throwaway PostgreSQL did not become ready in 30 s'); process.exit(1) }

  const vitestArgs = ['vitest', 'run', ...(CONFIG ? ['--config', CONFIG] : [TEST_FILE])]
  const run = spawnSync('npx', vitestArgs, {
    cwd: `${ROOT}/apps/api`,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEXUS_TEST_CONCURRENT_PG_URL: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/stock_race_no_stray_writes_test',
      DIRECT_URL: 'postgresql://nobody@127.0.0.1:1/stock_race_no_stray_writes_test',
    },
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const summary = output.split('\n').find((l) => /^\s+Tests\s+/.test(l))?.trim() ?? '(no test summary)'
  const passed = Number(summary.match(/(\d+) passed/)?.[1] ?? 0)
  const skipped = Number(summary.match(/(\d+) skipped/)?.[1] ?? 0)
  const failed = Number(summary.match(/(\d+) failed/)?.[1] ?? 0)
  if (run.status === 0 && passed === EXPECT && skipped === 0 && failed === 0) {
    console.log(`✓ stock race test: ${summary} (throwaway PostgreSQL, ${image})`)
    process.exit(0)
  }
  console.error(`❌ stock race test FAILED — ${summary}; vitest exit ${run.status}; expected ${EXPECT} passed, 0 skipped`)
  console.error(output.split('\n').filter((l) => /FAIL|AssertionError|Error:|expected|skipped/.test(l)).slice(0, 40).join('\n'))
  process.exit(1)
} finally {
  stop()
}
