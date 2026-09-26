#!/usr/bin/env node
//
// Business-profiles-ON ratchet for the API test suite.
//
// Production will run with NEXUS_WORKSPACES_ENABLED=1. The default local suite runs with it
// OFF (vitest.setup.ts), because until 2026-09-16 every test was written that way. Measured
// that day with profiles explicitly ON: 42 files / 218 tests fail — nearly all older tests that
// call code which, correctly, refuses to run without a business selected.
//
// Fixing all of them at once would mean editing 42 files owned by other work areas. Instead this
// holds the line while they are fixed one area at a time:
//
//   • a file NOT in the baseline that fails with profiles on           → FAIL (new breakage)
//   • a baselined file whose failure COUNT went up                     → FAIL (it got worse)
//   • a baselined file that now passes completely                      → FAIL until it is removed
//     from the baseline — so the list can only ever shrink, and a fixed file cannot silently
//     break again behind a stale entry
//   • a baselined file whose count went down but not to zero           → pass, with a note to lower it
//   • zero test files measured, or no report produced                  → FAIL ("could not measure"
//     is not "measured clean")
//
// A baseline value of "suite" means the file currently fails to LOAD, so it has no per-test count
// yet; any count is accepted until it loads, then record the real number.
//
//   node apps/api/scripts/profiles-on-ratchet.mjs                    check
//   node apps/api/scripts/profiles-on-ratchet.mjs --write            rewrite the baseline from this run
//   … --report=<a.json,b.json> judge existing vitest JSON reports (CI shards) instead of running the suite
//   … --baseline=<file.json>  compare against another baseline (both exist so every branch of this
//                             script can be proven without editing the real baseline or the code)
//
// Two baselines, because the two places measure different things:
//   profiles-on-baseline.json     the developer machine: the whole scope, catalogue suites included
//   profiles-on-baseline.ci.json  CI (docs/ci-plan.md §2.3): the whole API suite on a clean runner,
//                                 without the 4 catalogue suites and the real-PostgreSQL files
// A baselined file the run did not include is "not measured", never "fixed".

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const baselinePath = arg('baseline') ?? join(apiRoot, 'scripts', 'profiles-on-baseline.json')
const SCOPE = ['src/services', 'src/routes', 'src/lib', 'src/jobs', 'src/workers']
const write = process.argv.includes('--write')

function fail(lines) {
  console.error(`\n❌ profiles-ON ratchet FAILED\n\n${lines.join('\n')}\n`)
  process.exit(1)
}

// ── measure ─────────────────────────────────────────────────────────────────
let report
const given = arg('report')
if (given) {
  // CI shards the suite: several reports, comma-separated, are judged as one run.
  const paths = given.split(',').map(p => p.trim()).filter(Boolean)
  for (const p of paths) if (!existsSync(p)) fail([`--report=${p} does not exist.`])
  report = { testResults: paths.flatMap(p => JSON.parse(readFileSync(p, 'utf8')).testResults ?? []) }
} else {
  const dir = mkdtempSync(join(tmpdir(), 'profiles-on-'))
  const reportPath = join(dir, 'report.json')
  const run = spawnSync('npx', ['vitest', 'run', ...SCOPE, '--reporter=json', `--outputFile=${reportPath}`], {
    cwd: apiRoot,
    // Profiles ON explicitly — the setup file keeps an exported value. A dead Redis port, so no test
    // can reach a real queue.
    env: { ...process.env, NEXUS_WORKSPACES_ENABLED: '1', REDIS_URL: 'redis://127.0.0.1:1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!existsSync(reportPath)) {
    rmSync(dir, { recursive: true, force: true })
    fail(['vitest produced no report — the suite could not be measured.', (run.stderr || run.stdout || '').slice(-1500)])
  }
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
  rmSync(dir, { recursive: true, force: true })
}

const files = report.testResults ?? []
if (files.length === 0) fail(['The report lists zero test files — that is "could not measure", not "all clear".'])

const now = {}
for (const f of files) {
  if (f.status !== 'failed') continue
  const key = relative(apiRoot, f.name)
  const failed = (f.assertionResults ?? []).filter(a => a.status === 'failed').length
  // A file can fail with no failed assertion when it does not load at all.
  now[key] = failed > 0 ? failed : 'suite'
}

if (write) {
  const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(baselinePath, JSON.stringify({
    '//': 'Files that fail with NEXUS_WORKSPACES_ENABLED=1 and how many tests each. Only ever shrinks — see scripts/profiles-on-ratchet.mjs.',
    measuredAt: new Date().toISOString().slice(0, 10),
    files: sorted,
  }, null, 2) + '\n')
  const tests = Object.values(sorted).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0)
  console.log(`✓ baseline written: ${Object.keys(sorted).length} files, ${tests} failing tests (+ load failures) — ${relative(process.cwd(), baselinePath)}`)
  process.exit(0)
}

// ── compare ─────────────────────────────────────────────────────────────────
if (!existsSync(baselinePath)) fail([`No baseline at ${baselinePath}. Run with --write once to record today's state.`])
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).files ?? {}

const worse = []
const fixed = []
const improved = []
for (const [file, count] of Object.entries(now)) {
  if (!(file in baseline)) { worse.push(`  NEW   ${file} — ${count === 'suite' ? 'fails to load' : `${count} failing`} with profiles on`); continue }
  const before = baseline[file]
  if (before === 'suite' || count === 'suite') {
    if (before !== 'suite' && count === 'suite') worse.push(`  WORSE ${file} — had ${before} failing, now fails to LOAD`)
    continue
  }
  if (count > before) worse.push(`  WORSE ${file} — ${before} → ${count} failing`)
  else if (count < before) improved.push(`  ${file}: ${before} → ${count}`)
}
// "Fixed" means it RAN and passed. A baselined file this run did not include (a CI shard, a
// scoped run) was not measured, and absence of a measurement is not a pass.
const ran = new Set(files.map(f => relative(apiRoot, f.name)))
const gone = []
for (const file of Object.keys(baseline)) {
  if (!existsSync(join(apiRoot, file))) gone.push(`  ${file}`)
  else if (ran.has(file) && !(file in now)) fixed.push(`  ${file}`)
}

const lines = []
if (gone.length) {
  lines.push('These baseline entries name files that no longer exist — remove them:', ...gone, '')
}
if (worse.length) {
  lines.push('Something that works with profiles OFF now breaks with profiles ON, or got worse:', ...worse, '',
    '  Production runs with profiles on. Give the code a business to run in — the real callers do:',
    '  requests pass through the workspace hook, scheduled work runs per business in lib/cron/clustered.ts,',
    '  and WorkspaceWorker restores a job\'s business. See withWorkspace in lib/workspace-context.ts.', '')
}
if (fixed.length) {
  lines.push('These now PASS with profiles on — remove them from the baseline so they can never silently break again:',
    ...fixed, '', '  node apps/api/scripts/profiles-on-ratchet.mjs --write', '')
}
if (lines.length) fail(lines)

const total = Object.values(now).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0)
console.log(`✓ profiles-ON ratchet: ${files.length} files measured, ${Object.keys(now).length} known-failing (${total} tests) — none new, none worse.`)
if (improved.length) console.log(`  Improved — lower the baseline to hold the ground (--write):\n${improved.join('\n')}`)
