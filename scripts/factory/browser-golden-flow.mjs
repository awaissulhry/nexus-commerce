#!/usr/bin/env node
/**
 * browser-golden-flow — RULE: the one end-to-end W1 test (PLAN §4.7, B-W1-06) passes THROUGH THE SCREENS: one brand
 * size-run order from a new customer to a paid invoice and a CLOSED order, in a Playwright run with three kinds of
 * browser context (office people, link: the customer and the supplier, floor: enrolled tablets), every outside service
 * FAKE (SES, R2, SDI, Sendcloud, VIES, the print relay), on a fresh throwaway database, and nothing of the run stays.
 *
 *   1. Checks the local factory stack: PostgreSQL 17 on loopback (FACTORY_PG_TEST_SERVER_URL, else 127.0.0.1:5442) and
 *      Redis (127.0.0.1:6399); the API, control and web ports must be free.
 *   2. Starts the stack (apps/factory-web/tests/golden-flow/_harness/stack.ts): a throwaway database
 *      factory_test_<run>_bgf_… from the migrations + every base seed + the golden scenario, the API on :8276, the worker
 *      (relay + handlers) and the two polls in the same process (the FAKE SDI answers only the process that sent the
 *      file), a loopback control endpoint on :8277 for the test's harness. FACTORY_ENV=local, a fresh secrets master
 *      key, queue prefix w106 (its Redis keys are removed before and after).
 *   3. Starts the web (`next dev` on :3276, FACTORY_API_URL = the stack's API) and compiles the flow's pages once.
 *   4. Runs the spec apps/factory-web/tests/golden-flow.spec.ts (stages tests/golden-flow/NN-*.ts in order; a stage
 *      missing or blocked is reported by name) and the end checks it ends with.
 *   5. Runs the test that proves production refuses to start with a FAKE adapter (apps/factory-api:
 *      platform/gateway/boot-wiring.vitest.test.ts and the boot rule of gateway.pg.vitest.test.ts, on its own
 *      throwaway database).
 *   6. Stops the web and the stack by their process ids, drops every factory_test_<run>_… database left behind, prints
 *      the stages passed / blocked / missing / failed.
 *
 * Run: node scripts/factory/browser-golden-flow.mjs [--shots <dir>] [--headed] [--keep] [--stages 01-customer,02-style]
 *   --shots   where the screenshots, traces and logs go (default: a new folder in the system's temporary directory);
 *             never inside the repository.
 *   --keep    leave the stack and the web running after the spec (their process ids in <shots>/attach.json).
 *   --stages  run only these stages (comma-separated names); the others are skipped.
 *   --attach  with --shots of a kept run: run the spec again on that stack and web, the flow's state read back from
 *             <shots>/state.json (to work on one stage without walking the ones before it); add --stop to stop them.
 * Exit 1 when a stage or an end check fails, or the stack is not usable. Never touches a database it did not make.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { Redis } from 'ioredis'
import { tsImport } from 'tsx/esm/api'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB = join(ROOT, 'apps/factory-web')
const API = join(ROOT, 'apps/factory-api')
const HARNESS = join(WEB, 'tests/golden-flow/_harness')
const BIN = join(ROOT, 'node_modules/.bin')
const PORTS = { api: 8276, control: 8277, web: 3276 }
const PREFIX = 'w106'
const REDIS_URL = 'redis://127.0.0.1:6399'
// Pages the flow opens, compiled once before the spec so a first visit does not wait for the dev compiler.
const WARM = ['/sign-in', '/l', '/floor', '/floor/enrol', '/floor/sign-in', '/w/SCA/home/today', '/w/SCA/sales/customers', '/w/SCA/products/styles', '/w/SCA/compliance/certificates', '/w/SCA/sales/quotes', '/w/SCA/sales/orders', '/w/SCA/planning/mrp', '/w/SCA/purchasing/orders', '/w/SCA/production/work-orders', '/w/SCA/warehouse/shipping', '/w/SCA/finance/invoices', '/w/SCA/finance/payments', '/w/SCA/admin/devices', '/w/SCA/admin/users']

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const out = resolve(option('--shots') ?? mkdtempSync(join(tmpdir(), 'factory-browser-golden-flow-')))
if (!relative(ROOT, out).startsWith('..')) {
  console.error(`browser-golden-flow: --shots ${out} is inside the repository; keep the run's files outside it`)
  process.exit(1)
}
mkdirSync(out, { recursive: true })
const attach = flag('--attach')
const kept = attach ? JSON.parse(readFileSync(join(out, 'attach.json'), 'utf8')) : null
const run = kept?.run ?? randomBytes(4).toString('hex')
const started = Date.now()
const say = (line) => console.log(`browser-golden-flow: ${line}`)

const { testServerUrl } = await tsImport('../../packages/factory-db/src/testing/database.ts', import.meta.url)
const server = testServerUrl()

function portFree(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => (socket.destroy(), done(false)))
    socket.once('error', () => done(true))
  })
}

async function cleanRedis() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
  await redis.connect()
  let cursor = '0'
  let removed = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}:*`, 'COUNT', 1000)
    cursor = next
    if (keys.length > 0) removed += await redis.del(...keys)
  } while (cursor !== '0')
  redis.disconnect()
  return removed
}

/** A child in its own process group, its output in a file; stopped by its id. */
function start(name, command, commandArgs, options) {
  const log = openSync(join(out, `${name}.log`), 'a')
  const child = spawn(command, commandArgs, { ...options, detached: true, stdio: ['ignore', log, log] })
  child.unref()
  return child
}
function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}
const exited = (child, ms) => new Promise((done) => {
  if (child.exitCode !== null) return done(true)
  const timer = setTimeout(() => done(false), ms)
  child.once('exit', () => (clearTimeout(timer), done(true)))
})

async function waitFor(what, ms, check) {
  const until = Date.now() + ms
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() > until) throw new Error(`${what} did not come up in ${Math.round(ms / 1000)} s (see ${out})`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Starts the stack, then the web on its API, and compiles the flow's pages once. */
async function startEverything() {
  const version = (await root.query('SHOW server_version')).rows[0].server_version
  if (!/^1[7-9]\.|^[2-9]\d\./.test(version)) throw new Error(`the server runs PostgreSQL ${version}; the factory needs 17`)
  for (const [name, port] of Object.entries(PORTS)) if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is in use`)
  say(`run ${run} on PostgreSQL ${version} at ${server.host}; files in ${out}`)
  await cleanRedis()
  const stackEnv = {
    ...process.env,
    FACTORY_ENV: 'local',
    FACTORY_REDIS_URL: REDIS_URL,
    FACTORY_QUEUE_PREFIX: PREFIX,
    FACTORY_HOST: '127.0.0.1',
    FACTORY_PORT: String(PORTS.api),
    FACTORY_WEB_ORIGIN: `http://localhost:${PORTS.web}`,
    FACTORY_LOCAL_FILES_DIR: join(out, 'files'),
    FACTORY_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    FACTORY_BGF_CONTROL_PORT: String(PORTS.control),
    FACTORY_PG_TEST_RUN: run,
  }
  delete stackEnv.FACTORY_DATABASE_URL
  stack = start('stack', process.execPath, ['--import', 'tsx', join(HARNESS, 'stack.ts')], { cwd: API, env: stackEnv })
  ready = await waitFor('the stack', 240_000, async () => {
    if (stack.exitCode !== null) throw new Error(`the stack stopped (exit ${stack.exitCode}); see ${join(out, 'stack.log')}`)
    const line = readFileSync(join(out, 'stack.log'), 'utf8').split('\n').find((entry) => entry.startsWith('stack: ready '))
    return line ? JSON.parse(line.slice('stack: ready '.length)) : null
  })
  say(`stack ready: API ${ready.api}, database ${ready.database} (pid ${stack.pid})`)

  const webEnv = { ...process.env, FACTORY_API_URL: ready.api, NEXT_TELEMETRY_DISABLED: '1' }
  web = start('web', join(BIN, 'next'), ['dev', '-p', String(PORTS.web)], { cwd: WEB, env: webEnv })
  await waitFor('the web', 180_000, async () => {
    if (web.exitCode !== null) throw new Error(`the web stopped (exit ${web.exitCode}); see ${join(out, 'web.log')}`)
    const answer = await fetch(`http://localhost:${PORTS.web}/sign-in`, { redirect: 'manual' })
    return answer.status < 500
  })
  for (const path of WARM) await fetch(`http://localhost:${PORTS.web}${path}`, { redirect: 'manual' }).catch(() => {})
  say(`web ready on http://localhost:${PORTS.web} (pid ${web.pid}); pages compiled`)
}

let stack
let web
let failed = false
let ready
const root = new pg.Client({ connectionString: server.href })
try {
  await root.connect()
  if (kept) {
    ready = kept.ready
    stack = { pid: kept.stack, exitCode: null, once() {} }
    web = { pid: kept.web, exitCode: null, once() {} }
    say(`attached to the kept stack (pid ${kept.stack}) and web (pid ${kept.web})`)
  } else {
    await startEverything()
  }

  const report = join(out, 'report.json')
  const playwright = spawnSync(join(BIN, 'playwright'), ['test', '--config', join(HARNESS, 'playwright.config.ts'), ...(flag('--headed') ? ['--headed'] : [])], {
    cwd: WEB,
    stdio: 'inherit',
    env: {
      ...process.env,
      FACTORY_BGF_WEB: `http://localhost:${PORTS.web}`,
      FACTORY_BGF_CONTROL: ready.control,
      FACTORY_BGF_ADMIN_URL: ready.admin,
      FACTORY_BGF_OUT: out,
      FACTORY_BGF_REPORT: report,
      FACTORY_BGF_STAGES: option('--stages') ?? '',
      FACTORY_BGF_RESUME: attach ? '1' : '',
    },
  })
  if (playwright.status !== 0) failed = true
  if (existsSync(report)) {
    const results = JSON.parse(readFileSync(report, 'utf8'))
    const tests = (function walk(suite) {
      return [...(suite.specs ?? []).flatMap((spec) => spec.tests.map((entry) => ({ title: spec.title, entry }))), ...(suite.suites ?? []).flatMap(walk)]
    })({ suites: results.suites })
    const lines = tests.map(({ title, entry }) => {
      const result = entry.results.at(-1)
      const notes = entry.annotations.map((note) => `${note.type}: ${note.description}`).join('; ')
      const status = result?.status ?? 'not run'
      return `  ${status.padEnd(8)} ${title}${result?.duration ? ` (${Math.round(result.duration / 1000)} s)` : ''}${notes ? ` — ${notes}` : ''}`
    })
    const count = (status) => tests.filter(({ entry }) => (entry.results.at(-1)?.status ?? 'not run') === status).length
    say(`${tests.length} stage(s): ${count('passed')} passed, ${count('failed') + count('timedOut')} failed, ${count('skipped')} skipped`)
    console.log(lines.join('\n'))
  }

  // PLAN §4.7: a separate test proves production refuses to start with a FAKE adapter (A1 §4; platform/gateway/boot.ts).
  say('the production-refuses-a-fake test (apps/factory-api platform/gateway: boot wiring + the boot rule on PostgreSQL)')
  // Its PostgreSQL half migrates a throwaway database under the server's migration lock: on a server other worktrees
  // load, its 60 s set-up can run out, so a failed first try runs once more before it counts.
  const bootTest = () =>
    spawnSync(join(BIN, 'vitest'), ['run', 'src/platform/gateway/boot-wiring.vitest.test.ts', 'src/platform/gateway/gateway.pg.vitest.test.ts', '-t', 'boot'], {
      cwd: API,
      stdio: 'inherit',
      env: { ...process.env, FACTORY_PG_TEST_RUN: run, FACTORY_DATABASE_URL: `postgresql://factory_app@127.0.0.1:5442/factory_test_${run}_guard` },
    })
  let boot = bootTest()
  if (boot.status !== 0) {
    say('the production-refuses-a-fake test failed once; running it again')
    boot = bootTest()
  }
  if (boot.status !== 0) {
    failed = true
    say('the production-refuses-a-fake test FAILED')
  }
} catch (error) {
  console.error(`browser-golden-flow: ${error.message}`)
  failed = true
} finally {
  if ((flag('--keep') || (attach && !flag('--stop'))) && stack && web && stack.exitCode === null) {
    writeFileSync(join(out, 'attach.json'), JSON.stringify({ ready, stack: stack.pid, web: web.pid, run }, null, 2))
    say(`kept running: stack pid ${stack.pid} (API ${ready?.api}, control ${ready?.control}), web pid ${web.pid}; --attach --shots ${out} runs the spec again, --stop stops them`)
  } else {
    if (attach) {
      for (const child of [web, stack]) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    } else {
      stop(web)
      if (web && !(await exited(web, 15_000))) stop(web, 'SIGKILL')
      stop(stack)
      if (stack && !(await exited(stack, 30_000))) stop(stack, 'SIGKILL')
    }
    const left = (await root.query('SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY 1', [`factory_test_${run}_`]).catch(() => ({ rows: [] }))).rows
    for (const { datname } of left) await root.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
    if (left.length > 0) say(`dropped ${left.length} database(s) the run left behind`)
    await cleanRedis().catch(() => {})
  }
  await root.end().catch(() => {})
}
say(`${failed ? 'FAILED' : 'passed'} in ${Math.round((Date.now() - started) / 1000)} s (screenshots, traces and logs: ${out})`)
process.exit(failed ? 1 : 0)
