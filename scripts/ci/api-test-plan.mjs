#!/usr/bin/env node
/**
 * CI Tier C (docs/ci-plan.md §2.3) — which API test files run in which CI shard, and a check that
 * nothing was lost on the way.
 *
 * WHY THE WHOLE SUITE
 * Choosing "security" tests by name or content misses real ones (webhook signatures, OAuth, credential
 * crypto, SSRF guards all have names that say nothing about security). So CI runs EVERY API test file
 * on every PR, split into shards, in both business-profile modes. The only files left out are listed
 * in EXCLUDED below, each with the job that runs it instead or the reason it cannot run on a clean
 * runner.
 *
 * THE RULES
 * - Every collected test file lands in exactly one place: one shard, or EXCLUDED. A file in neither or
 *   in both fails. An EXCLUDED entry that names a file which no longer exists fails.
 * - Zero files anywhere is a refusal, not a pass.
 * - After a run, a test file that skipped ALL its tests must be on SKIP_ALLOWED. A test that skips
 *   because CI forgot an environment variable measured nothing, and that must be loud.
 *
 *   node scripts/ci/api-test-plan.mjs --shard 1/4          print shard 1's files, one per line (CI: 4 shards)
 *   node scripts/ci/api-test-plan.mjs --shard 1/4 --run -- --reporter=json …   run vitest on them
 *     (the file list goes to vitest as an argument array, so no shell can mangle it)
 *   node scripts/ci/api-test-plan.mjs --summary            print the counts and the exclusions
 *   node scripts/ci/api-test-plan.mjs --check-skips a.json[,b.json]   judge vitest JSON reports
 *   node scripts/ci/api-test-plan.mjs --write-durations a.json[,b.json]  refresh the balancing data
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API = join(ROOT, 'apps', 'api')
const DURATIONS = join(ROOT, 'scripts', 'ci', 'api-test-durations.json')

const CATALOGUE = 'reads the developer catalogue (nexus_development); manual: npm run gates:full'
const REAL_PG = 'runs in the CI postgres job (scripts/run-real-postgres-tests.mjs)'
const LOCAL = 'opt-in rehearsal against a local database copy (PR*_LOCAL env); not a CI test'
const NIGHTLY = 'real-PostgreSQL load test; nightly (docs/ci-plan.md §2.5)'

/** Relative to apps/api. Every entry needs a reason. */
export const EXCLUDED = {
  'src/services/pim/variation-ebay-precedence.vitest.test.ts': CATALOGUE,
  'src/services/pim/variation-mapping-filter.vitest.test.ts': CATALOGUE,
  'src/services/pim/variation-rule-view.vitest.test.ts': CATALOGUE,
  'src/services/pim/variation-quality.vitest.test.ts': CATALOGUE,
  'src/lib/testing/database-target.vitest.test.ts': 'asserts THIS machine\'s real .env files and nexus_development by design (R-VT-12); manual: npm run gates:full',
  'src/lib/listing-coordinate.local.vitest.test.ts': LOCAL,
  'src/lib/listing-coordinate-sites.local.vitest.test.ts': LOCAL,
  'src/services/delist-cascade.local.vitest.test.ts': LOCAL,
  'src/services/outbound-sync.not-sent.local.vitest.test.ts': LOCAL,
  'src/services/products/impact.local.vitest.test.ts': LOCAL,
  'src/services/shopify/presence-preconditions.vitest.test.ts': LOCAL,
  'src/services/stock-pool/stock-pool-rush.vitest.test.ts': NIGHTLY,
  'src/services/assortment/sync-load.vitest.test.ts': NIGHTLY,
}

/** Files that may skip every test in CI, and why. Keep this list short. */
export const SKIP_ALLOWED = {}

function realPostgresFiles() {
  const source = readFileSync(join(ROOT, 'scripts', 'run-real-postgres-tests.mjs'), 'utf8')
  const files = [...source.matchAll(/file:\s*'([^']+\.test\.ts)'/g)].map(m => m[1])
  if (files.length === 0) throw new Error('found no suites in scripts/run-real-postgres-tests.mjs — refusing to guess')
  return files
}

/** Every file the API vitest config collects, relative to apps/api. */
export function collected() {
  const list = args => execFileSync('git', args, { cwd: API, encoding: 'utf8' }).split('\n').filter(Boolean)
  const files = new Set([...list(['ls-files', 'src']), ...list(['ls-files', '--others', '--exclude-standard', 'src'])])
  return [...files].filter(f => existsSync(join(API, f)) && (/\/__tests__\/[^/]+\.test\.ts$/.test(f) || f.endsWith('.vitest.test.ts'))).sort()
}

export function plan() {
  const all = collected()
  const excluded = { ...EXCLUDED }
  for (const f of realPostgresFiles()) excluded[f] = REAL_PG
  const problems = []
  for (const f of Object.keys(excluded)) if (!all.includes(f)) problems.push(`excluded file does not exist or is not collected: ${f}`)
  const included = all.filter(f => !(f in excluded))
  if (all.length === 0 || included.length === 0) problems.push('zero test files collected — refusing to call that a pass')
  return { all, included, excluded, problems }
}

function durations() {
  try { return JSON.parse(readFileSync(DURATIONS, 'utf8')).files ?? {} } catch { return {} }
}

/** Greedy longest-first split, so the slow database files do not pile into one shard. */
export function shards(files, count, weights = durations()) {
  const bins = Array.from({ length: count }, () => ({ total: 0, files: [] }))
  const weighted = files.map(f => ({ f, w: weights[f] ?? 1000 })).sort((a, b) => b.w - a.w || a.f.localeCompare(b.f))
  for (const { f, w } of weighted) {
    const bin = bins.reduce((min, b) => (b.total < min.total ? b : min))
    bin.total += w
    bin.files.push(f)
  }
  return bins.map(b => ({ total: b.total, files: b.files.sort() }))
}

function readReports(arg) {
  const paths = arg.split(',').map(p => p.trim()).filter(Boolean)
  return paths.flatMap(p => JSON.parse(readFileSync(p, 'utf8')).testResults ?? [])
}

function fail(lines) {
  console.error(lines.join('\n'))
  process.exit(1)
}

const dashdash = process.argv.indexOf('--')
const args = dashdash >= 0 ? process.argv.slice(2, dashdash) : process.argv.slice(2)
const vitestArgs = dashdash >= 0 ? process.argv.slice(dashdash + 1) : []
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { all, included, excluded, problems } = plan()
  if (problems.length) fail(['✗ API test plan is inconsistent:', ...problems.map(p => `  ${p}`)])

  if (value('--shard')) {
    const [index, count] = value('--shard').split('/').map(Number)
    if (!(index >= 1 && index <= count)) fail([`✗ --shard must look like 1/3, got ${value('--shard')}`])
    const bins = shards(included, count)
    const covered = bins.flatMap(b => b.files)
    if (covered.length !== included.length || new Set(covered).size !== included.length) fail(['✗ the shards do not cover every included file exactly once'])
    const mine = bins[index - 1].files
    if (mine.length === 0) fail([`✗ shard ${index}/${count} has no files — refusing to call that a pass`])
    if (args.includes('--run')) {
      console.log(`shard ${index}/${count}: ${mine.length} of ${included.length} files`)
      const run = spawnSync(join(ROOT, 'node_modules', '.bin', 'vitest'), ['run', '--project', 'regressions', ...mine, ...vitestArgs], { cwd: API, stdio: 'inherit' })
      process.exit(run.status ?? 1)
    }
    for (const f of mine) console.log(f)
  } else if (value('--check-skips')) {
    const results = readReports(value('--check-skips'))
    if (results.length === 0) fail(['✗ the reports list zero test files — could not measure'])
    // A FAILED file whose setup threw also reports every test as skipped; vitest's exit code and the
    // profiles-ON ratchet judge those. This check is about files that passed while measuring nothing.
    const skippedWhole = results.filter(r => {
      if (r.status === 'failed') return false
      const a = r.assertionResults ?? []
      return a.length > 0 && a.every(t => t.status === 'skipped' || t.status === 'pending' || t.status === 'todo')
    }).map(r => relative(API, r.name))
    const unexpected = skippedWhole.filter(f => !(f in SKIP_ALLOWED))
    console.log(`skip check: ${results.length} files reported, ${skippedWhole.length} skipped every test`)
    if (unexpected.length) fail(['✗ these files skipped every test in CI — a missing environment variable, or a test that cannot run here:', ...unexpected.map(f => `  ${f}`), '  Give CI what the test needs, exclude it with a reason, or add it to SKIP_ALLOWED with a reason.'])
  } else if (value('--write-durations')) {
    const results = readReports(value('--write-durations'))
    const files = Object.fromEntries(results.map(r => [relative(API, r.name), Math.round((r.endTime ?? 0) - (r.startTime ?? 0))]).filter(([, ms]) => ms > 0).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(DURATIONS, JSON.stringify({ '//': 'Per-file wall time (ms) from a CI-like run; only used to balance shards. Refresh with --write-durations.', measuredAt: new Date().toISOString().slice(0, 10), files }, null, 2) + '\n')
    console.log(`✓ wrote ${Object.keys(files).length} durations to ${relative(ROOT, DURATIONS)}`)
  } else {
    console.log(`API test plan: ${all.length} collected · ${included.length} run in CI shards · ${Object.keys(excluded).length} excluded`)
    for (const [f, why] of Object.entries(excluded)) console.log(`  excluded ${f} — ${why}`)
  }
}
