#!/usr/bin/env node
/**
 * THE BROWSER GATES, back in the push — A-43, rulings R-45 (they come back) and R-50 (the push starts its own servers).
 *
 *   node scripts/run-browser-gates.mjs --pre-push          # the hook: only the gates whose files the pushed commits touch
 *   npm run gates:browser                                   # all three gates, now
 *   node scripts/run-browser-gates.mjs --all --update-baseline   # re-record the known failures (lower the ratchet)
 *
 * ## Why this exists
 *
 * `7bd90cb11` (2026-09-16) took grid chrome, the open-gesture gate and the control census out of `.githooks/pre-push`
 * on the Owner's decision: they drove a real browser against :3000, needed a signed-in studio session and the pusher's
 * own dev servers, and added ~20 minutes to every push. Measured 2026-09-23 (U2): by then none of the three could even
 * run — every page needs a user, the sign-in helper waited for the wrong URL, the wrapper's aloneness witness was blind
 * on macOS, and the open-gesture gate's write guard no longer covered the API path the page uses. Those are fixed in
 * their own files; this runner is how they re-enter the hook without the old cost:
 *
 *   1. **Path-scoped.** A push runs a gate only when its commits touch a file that gate's reading depends on — each gate's
 *      own `STAMP_FILES`, parsed from its source (never a second hand-kept list), plus this runner's own dependencies.
 *      Nothing watched changed → one printed line, `browser gates: no watched file changed — not run`, and a pass.
 *   2. **Its own servers (R-50).** An API and a web dev server on FREE ports, on the LOCAL database, started here and
 *      stopped here — also on failure and on Ctrl-C. It never reuses or stops a server it did not start. The web server
 *      builds into its own `.next-gate-<pid>`, so the hook's `next build` (its own `.next-push-<pid>`) cannot collide.
 *   3. **A ratchet.** Each gate reports its failures (`scripts/lib/gate-report.mjs`); a failure's KEY masks the measured
 *      numbers. The push fails only on a key NOT in `scripts/browser-gates-baseline.json`. A baseline key that no longer
 *      fails is printed as "the ratchet can fall" — `--update-baseline` records it.
 *   4. **Never a false green.** A server that will not start, a wrapper that refuses, a gate that writes no report (it
 *      refused, could not sign in, or crashed) — each is NOT MEASURED, and NOT MEASURED fails the push with its reason.
 *
 * ## The production guard, stated because the API makes it necessary
 *
 * `apps/api/src/env.ts` loads `apps/api/.env` and THEN the repo-root `.env` (non-overriding) — and the root `.env` on this
 * machine is PRODUCTION (channel credentials, encryption keys, cron switches). So the runner (a) sets `DATABASE_URL` and
 * `DIRECT_URL` from `apps/api/.env` explicitly and refuses unless the host is loopback and the database answers
 * `nexus_development`; (b) reads the root `.env`'s KEY NAMES — never a value — and sets every key that `apps/api/.env`
 * does not define to an empty string for both servers, so no production value can take effect (a set variable is never
 * overridden by dotenv); (c) reads the started API process's own environment back (`ps -E`) and refuses unless it holds
 * the local URL. The gate wrapper then signs in a disposable user that exists only on the local database — a sign-in
 * that works is a second, independent proof of which database the API reads.
 */
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, writeSync, existsSync, rmSync, mkdtempSync, openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import pg from 'pg'
import { failureKey } from './lib/gate-report.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const BASELINE = join(ROOT, 'scripts/browser-gates-baseline.json')
const argv = process.argv.slice(2)
const PRE_PUSH = argv.includes('--pre-push')
const ALL = argv.includes('--all')
const UPDATE = argv.includes('--update-baseline')
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }

/** The gates, in the order they run. One at a time: two browser gates on one server measure each other. */
/**
 * The gate API's own switches. `NEXUS_AMAZON_ENV_TOKEN=off` (2026-09-24): with the production-only Amazon keys blanked, the
 * API's boot seed (`index.ts` seedEnvManagedConnections) otherwise rewrote the LOCAL env-managed Amazon connection to
 * `isActive: false, authStatus: 'disconnected'` on every gate run — a side effect on the shared local database that made two
 * local-database API tests fail at the next push. With it off, boot leaves that row untouched and no code path may use the
 * environment refresh token (`useAmazonEnvToken` refuses by name).
 */
export const GATE_API_ENV = Object.freeze({ NEXUS_API_HOST: '127.0.0.1', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: '0', NEXUS_AMAZON_ENV_TOKEN: 'off' })

export const GATES = [
  { id: 'grid-chrome', script: 'scripts/check-grid-chrome.mjs', args: ['--strict'] },
  { id: 'editor-open', script: 'scripts/check-editor-open.mjs', args: ['--strict'] },
  { id: 'control-census', script: 'scripts/check-control-census.mjs', args: [] },
]
/** What every gate's ability to RUN depends on — a change here runs all three. The runner's own dependencies. */
export const COMMON = [
  'scripts/run-browser-gates.mjs',
  'scripts/browser-gates-baseline.json',
  'scripts/studio-gate-session.mjs',
  'scripts/studio-browser-auth.mjs',
  'scripts/lib/gate-aloneness.mjs',
  'scripts/lib/gate-write-guard.mjs',
  'scripts/lib/gate-report.mjs',
  'apps/web/src/proxy.ts',
  'apps/web/src/lib/workspaces/',
  'apps/web/src/lib/backend-url.ts',
  'apps/web/src/app/layout.tsx',
  'apps/web/next.config.js',
]

/** PURE. A gate's `STAMP_FILES`, parsed from its source. `null` when the list cannot be read. */
export function stampFilesOf(source) {
  const m = /const STAMP_FILES = \[([\s\S]*?)\n\]/.exec(source)
  if (!m) return null
  const list = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  return list.length ? list : null
}

/** PURE. Does a changed path fall under a watched entry? An entry ending `/` covers everything below it. */
export const watches = (entry, file) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)

/** PURE. Which gates must run for these changed files. */
export function gatesToRun(changed, stampsByGate) {
  const common = changed.some((f) => COMMON.some((w) => watches(w, f)))
  return GATES.filter((g) => common || changed.some((f) => stampsByGate[g.id].some((w) => watches(w, f))))
}

/** PURE. The ratchet: `{ newKeys, dropped }` for one gate's measured keys against its baseline keys. */
export function ratchet(measured, baseline = []) {
  const base = new Set(baseline)
  const now = new Set(measured)
  return { newKeys: [...now].filter((k) => !base.has(k)), dropped: [...base].filter((k) => !now.has(k)) }
}

/**
 * PURE. The push's verdict over the gates' results. NOT MEASURED always fails; a NEW key fails unless the baseline is
 * being re-recorded (`--update-baseline`, run by hand — never from the hook); a key that no longer fails never does.
 */
export function verdict(results, { update = false } = {}) {
  let failed = false
  const lines = []
  for (const r of results) {
    if (!r.measured) {
      failed = true
      lines.push(`❌ ${r.gate.id}: NOT MEASURED (exit ${r.code}, ${r.secs}s) — ${r.timedOut ? 'stopped at the time limit' : 'it wrote no report: it refused, could not sign in or crashed'}. See the output above. A gate that cannot look is not green.`)
      continue
    }
    const line = `${r.gate.id}: ${r.keys.length} failure key(s), ${r.newKeys.length} new, ${r.dropped.length} gone (exit ${r.code}, ${r.secs}s)`
    if (r.newKeys.length && !update) {
      failed = true
      lines.push(`❌ ${line}`)
      for (const k of r.newKeys) lines.push(`     NEW · ${k}`)
    } else lines.push(`✓ ${line}`)
    for (const k of r.dropped) lines.push(`     the ratchet can fall — no longer failing · ${k}`)
    /* A baselined "NOT MEASURED" is a KNOWN BLIND SPOT, not a pass: say so on every run, so it can never read as green. */
    const blind = r.keys.filter((k) => /NOT MEASURED/.test(k) && !r.newKeys.includes(k))
    if (blind.length) lines.push(`  ⚠ ${r.gate.id}: ${blind.length} known row(s) NOT MEASURED — the gate is BLIND there (baselined, not green)`)
  }
  return { failed, lines }
}

/** KEY NAMES of a dotenv file — never a value. */
export function envKeyNames(text) {
  return String(text).split('\n').map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean)
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

function changedFiles() {
  const forced = process.env.BROWSER_GATES_CHANGED // a test seam: a comma-separated list stands in for `git diff`
  if (forced !== undefined) return { range: '(BROWSER_GATES_CHANGED)', files: forced.split(',').map((s) => s.trim()).filter(Boolean) }
  let base
  try { base = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') } catch { base = null }
  if (!base) base = git('merge-base', 'HEAD', 'origin/main')
  const range = flag('range') ?? `${base}..HEAD`
  return { range, files: git('diff', '--name-only', range).split('\n').filter(Boolean) }
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

function localDatabaseUrl() {
  const line = readFileSync(join(ROOT, 'apps/api/.env'), 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='))
  if (!line) throw new Error('apps/api/.env carries no DATABASE_URL')
  const url = line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`apps/api/.env's DATABASE_URL points at ${host}, not this machine — refusing`)
  return url
}

async function assertLocalDatabase(url) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const name = (await client.query('SELECT current_database() AS name')).rows[0].name
    if (name !== 'nexus_development') throw new Error(`the local DATABASE_URL answers "${name}", not nexus_development — refusing`)
  } finally { await client.end() }
}

/** Every root `.env` key `apps/api/.env` does not define, set EMPTY — so no production value can take effect. */
function productionBlanks() {
  const rootPath = join(ROOT, '.env')
  if (!existsSync(rootPath)) return {}
  const apiKeys = new Set(envKeyNames(readFileSync(join(ROOT, 'apps/api/.env'), 'utf8')))
  return Object.fromEntries(envKeyNames(readFileSync(rootPath, 'utf8')).filter((k) => !apiKeys.has(k)).map((k) => [k, '']))
}

const started = []
let cleaned = false
export function stopAll() {
  if (cleaned) return
  cleaned = true
  for (const p of started) {
    if (p.child.exitCode === null && p.child.signalCode === null) {
      try { process.kill(-p.child.pid, 'SIGTERM') } catch { /* already gone */ }
    }
  }
  const deadline = Date.now() + 10_000
  for (const p of started) {
    while (Date.now() < deadline) {
      try { process.kill(-p.child.pid, 0) } catch { break }
      execFileSync('sleep', ['0.2'])
    }
    try { process.kill(-p.child.pid, 'SIGKILL') } catch { /* stopped */ }
    console.log(`browser gates: stopped ${p.name} (pid ${p.child.pid})`)
  }
  for (const p of started) if (p.distDir) { try { rmSync(p.distDir, { recursive: true, force: true }) } catch { /* best effort */ } }
}
process.on('exit', stopAll)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopAll(); process.exit(130) })

export function startServer(name, cmd, args, { cwd, env, log, distDir }) {
  const fd = openSync(log, 'a')
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  started.push({ name, child, distDir })
  return child
}

export async function waitFor(url, child, ms, log, name) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} exited (${child.exitCode ?? child.signalCode}) before answering — last log lines:\n${tail(log)}`)
    }
    const ok = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) }).then((r) => r.status > 0 && r.status < 500).catch(() => false)
    if (ok) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${name} did not answer ${url} within ${Math.round(ms / 1000)}s — last log lines:\n${tail(log)}`)
}
const tail = (log) => { try { return readFileSync(log, 'utf8').trim().split('\n').slice(-12).join('\n') } catch { return '(no log)' } }

/** The started API's OWN environment, read back — the discriminator, not an inference. */
function processDatabaseUrl(pid) {
  const out = execFileSync('ps', ['-E', '-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return /(?:^|\s)DATABASE_URL=(\S+)/.exec(out)?.[1] ?? null
}

/** A gate that runs longer than this is stopped and reported NOT MEASURED. Measured 2026-09-24: a full editor-open on the
 *  local copy takes ~15 minutes; a gate stuck on a blind scope once ran silent for 48. */
const GATE_TIMEOUT_MS = Number(process.env.BROWSER_GATE_TIMEOUT_MS ?? 30 * 60_000)

/** The gate process under the wrapper — stopped, never the wrapper, so the wrapper's `finally` still deletes its
 *  disposable user and releases its lock. */
function gateChildOf(wrapperPid) {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
      .find(([, , ppid, args]) => Number(ppid) === wrapperPid && /scripts\/check-/.test(args))?.[1] ?? null
  } catch { return null }
}

function runGate(gate, env, reportPath, log) {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/studio-gate-session.mjs', '--', 'node', gate.script, ...gate.args],
      { cwd: ROOT, env: { ...env, GATE_REPORT: reportPath }, stdio: ['ignore', 'pipe', 'pipe'] })
    const fd = openSync(log, 'a')
    const pipe = (d) => { process.stdout.write(d); try { writeSync(fd, d) } catch { /* the log is best effort */ } }
    child.stdout.on('data', pipe)
    child.stderr.on('data', pipe)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      const pid = gateChildOf(child.pid)
      console.log(`\n⏱ browser gates: ${gate.id} passed ${Math.round(GATE_TIMEOUT_MS / 60000)} minutes — stopping the gate (pid ${pid ?? '?'}); the wrapper cleans up`)
      try { process.kill(Number(pid ?? child.pid), 'SIGTERM') } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGTERM') } catch { /* gone */ } }, 60_000).unref()
    }, GATE_TIMEOUT_MS)
    child.on('exit', (code, signal) => { clearTimeout(timer); closeSync(fd); resolve({ code: code ?? (signal ? 128 : 1), timedOut }) })
  })
}

async function main() {
  const t0 = Date.now()
  if (UPDATE && PRE_PUSH) throw new Error('--update-baseline is a deliberate act by hand — never from the push hook')
  const stamps = {}
  for (const g of GATES) {
    const list = stampFilesOf(readFileSync(join(ROOT, g.script), 'utf8'))
    if (!list) throw new Error(`${g.script} declares no STAMP_FILES — the runner cannot tell which pushes must run it`)
    stamps[g.id] = list
  }
  let toRun = GATES
  if (PRE_PUSH && !ALL) {
    const { range, files } = changedFiles()
    toRun = gatesToRun(files, stamps)
    if (toRun.length === 0) {
      console.log(`browser gates: no watched file changed — not run (${files.length} file(s) in ${range})`)
      return 0
    }
    console.log(`browser gates: ${toRun.map((g) => g.id).join(', ')} — watched files changed in ${range}`)
  }

  const work = mkdtempSync(join(tmpdir(), 'nexus-browser-gates-'))
  const dbUrl = localDatabaseUrl()
  await assertLocalDatabase(dbUrl)
  const blanks = productionBlanks()
  const apiPort = await freePort()
  const webPort = await freePort()
  const webBase = `http://localhost:${webPort}`
  console.log(`browser gates: own servers — API :${apiPort}, web :${webPort}, database ${new URL(dbUrl).host}${new URL(dbUrl).pathname}; ${Object.keys(blanks).length} production-only key(s) blanked; logs ${work}`)

  const baseEnv = { ...process.env, ...blanks, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl }
  const apiLog = join(work, 'api.log')
  const api = startServer('API', process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'apps/api'), log: apiLog,
    env: { ...baseEnv, PORT: String(apiPort), ...GATE_API_ENV },
  })
  const nextBin = createRequire(join(ROOT, 'apps/web/package.json')).resolve('next/dist/bin/next')
  const distDir = `.next-gate-${process.pid}`
  const webLog = join(work, 'web.log')
  const web = startServer('web', process.execPath, [nextBin, 'dev', '-p', String(webPort)], {
    cwd: join(ROOT, 'apps/web'), log: webLog, distDir: join(ROOT, 'apps/web', distDir),
    env: { ...baseEnv, NEXT_DIST_DIR: distDir, NEXUS_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}`, NEXT_DEV_STUB_PROXY: `http://127.0.0.1:${apiPort}`, NEXT_TELEMETRY_DISABLED: '1' },
  })
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`, api, 180_000, apiLog, 'the API')
  const seen = processDatabaseUrl(api.pid)
  if (seen !== dbUrl) throw new Error(`the started API's own environment holds DATABASE_URL=${seen ? new URL(seen).host : 'nothing'} — not the local database; refusing`)
  await waitFor(`${webBase}/login`, web, 300_000, webLog, 'the web server')
  console.log(`browser gates: servers up in ${Math.round((Date.now() - t0) / 1000)}s (the API's own environment reads the local database)`)

  /* Compile the gates' pages once, before any gate waits on them: `next dev` compiles a route on its first request (its
     filesystem cache is off by config), and a cold compile inside a gate's 60-second rows wait read as "no rows". A signed-
     out request still compiles the route — the redirect to /login happens only when it renders. Any workspace id works. */
  for (const path of ['/design/grid-lab', '/w/warmup/products/warmup/edit/studio']) {
    const w0 = Date.now()
    await fetch(`${webBase}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(300_000) }).catch(() => null)
    console.log(`browser gates: compiled ${path} in ${Math.round((Date.now() - w0) / 1000)}s`)
  }
  const gateEnv = { ...baseEnv, EDITOR_BASE: webBase, EDITOR_API: `${webBase}/backend`, CENSUS_BASE: webBase, GDS_BASE: webBase }
  delete gateEnv.STUDIO_API_BASE
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { gates: {} }
  const results = []
  for (const gate of toRun) {
    const g0 = Date.now()
    const reportPath = join(work, `${gate.id}.json`)
    console.log(`\n━━ browser gate ${gate.id} ━━`)
    const { code, timedOut } = await runGate(gate, gateEnv, reportPath, join(work, `${gate.id}.log`))
    const secs = Math.round((Date.now() - g0) / 1000)
    if (timedOut || !existsSync(reportPath)) { results.push({ gate, code, secs, measured: false, timedOut }); continue }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const keys = [...new Set(report.failures.map(failureKey))]
    results.push({ gate, code, secs, measured: true, keys, ...ratchet(keys, baseline.gates?.[gate.id]) })
  }

  console.log('\n━━ browser gates — summary ━━')
  const { failed, lines } = verdict(results, { update: UPDATE })
  for (const l of lines) console.log(l)
  if (UPDATE) {
    const next = { ...baseline, recordedAt: new Date().toISOString(), gates: { ...(baseline.gates ?? {}) } }
    for (const r of results) if (r.measured) next.gates[r.gate.id] = r.keys
    writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n')
    console.log(`browser gates: baseline written (${results.filter((r) => r.measured).map((r) => r.gate.id).join(', ') || 'nothing measured'})`)
  }
  console.log(`browser gates: ${Math.round((Date.now() - t0) / 1000)}s in total`)
  return failed ? 1 : 0
}

if (import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href) {
  main().then((code) => { stopAll(); process.exit(code) }, (error) => {
    console.error(`❌ browser gates: ${error.message}\n   NOT MEASURED — the push cannot claim green. Re-run: npm run gates:browser`)
    stopAll()
    process.exit(1)
  })
}
