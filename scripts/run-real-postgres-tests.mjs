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
 *   · `stock-pool-concurrency.vitest.test.ts` (shared stock, plan 2026-09-19) — two businesses selling the
 *     same units at the same moment through their own writers and the pool doors: one winner, no lost
 *     update, and a control that removes the door's lock and must break.
 *   · `stock-pool-e2e.vitest.test.ts` (shared stock) — the switches end to end through the real services,
 *     cascade and pool worker; the worker runs on several connections at once.
 *   · `listing-end-times.vitest.test.ts` (shared stock step 3) — "Fixed number until …" and "Paused
 *     until …" end to end: the Sync Control route and Excel import, the end-time job, the real writer and
 *     cascade, and the database triggers that clear an end time with its mode.
 *   · `order-stock-once-postgres.vitest.test.ts` (hotfix 2026-09-26) — an order line's stock is taken once:
 *     re-reads of shipped orders, an oversold line taken once stock arrives, surplus holds, the reconcile, races.
 *   · `stock-pool-orders.vitest.test.ts` (shared stock step 4) — orders through the doors: the real eBay
 *     ingest, holds / take out / give back, cancellations, the returns route, the guard and the repair job.
 *   · `stock-model-postgres.vitest.test.ts` (stock model 2026-09-26) — one stock model across channels: a
 *     shipped order whose stock work died healed by the next poll and the reconcile, per-product totals,
 *     hold identity across own ↔ shared stock switches, one shortfall class, and a poll, a reconcile, a
 *     cancellation and a stock-page release racing on one order.
 *   · `assortment/sync.vitest.test.ts` (shared stock step 6, AE.4) — live product sync: the capture
 *     trigger, the worker through the real transfer engine, overrides and "Follow again", images, SKU
 *     holds, new variations, retries, no chains, and the delay measured with the real LISTEN/NOTIFY.
 *   · `assortment/copy-unknown-market.vitest.test.ts` (AE.3, 2026-09-21) — a first copy into a business
 *     that sells NOWHERE YET: the column model reads Marketplace and ChannelListing, so only a real server
 *     can show that the reference market belongs to the SHARING business and that the receiving profile,
 *     which has no Marketplace row, must not be refused by the strict check.
 *   · `assortment/copy-inherited-attribute.vitest.test.ts` (AE.3, 2026-09-29) — a Link copy whose variations
 *     inherit an attribute the receiving family keeps off the master sheet: only the REAL column model shows
 *     that such a variation has no column there, and that its inherited row must link, not be refused.
 *   · `category-tree-concurrency.vitest.test.ts` (2026-09-26) — concurrent category moves, creates, membership
 *     replacements and Categories workspace commands serialize on the business's category-tree lock.
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
 *   node scripts/run-real-postgres-tests.mjs                     # production-equivalent owner by default
 *   node scripts/run-real-postgres-tests.mjs --owner production   # as a non-superuser owner, production's rights
 *   node scripts/run-real-postgres-tests.mjs --required           # CI: missing Docker or image FAILS instead of skipping
 *   node scripts/run-real-postgres-tests.mjs --suites '[{"name":"x","file":"src/…","expect":1}]'   # harness use
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = `${ROOT}/apps/api`
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const SUITES = flag('--suites') ? JSON.parse(flag('--suites')) : [
  { name: 'disposable database teardown (autovacuum retried, a leaked connection fails at once)', file: 'src/test-support/concurrent-database.vitest.test.ts', expect: 3 },
  { name: 'saved listing issues (account and profile isolation, live keyset pages)', file: 'src/services/cx/listing-issues-postgres.vitest.test.ts', expect: 7 },
  { name: 'inbound receipt identity (simultaneous delivery and profile isolation)', file: 'src/services/cx/ingress/receipt-postgres.vitest.test.ts', expect: 8 },
  { name: 'retained inbound history (archive/replay races and database deletion guards)', file: 'src/services/cx/ingress/archive-postgres.vitest.test.ts', expect: 14 },
  { name: 'durable eBay receipt claims and atomic domain commit', file: 'src/services/cx/ingress/ebay-claims-postgres.vitest.test.ts', expect: 15 },
  { name: 'fenced manual eBay replay (clock skew, claims and concurrent operators)', file: 'src/services/cx/ingress/ebay-replay-postgres.vitest.test.ts', expect: 7 },
  { name: 'private eBay admission and recovery (ownership, quarantine, handoff and transfer races)', file: 'src/services/cx/ingress/ebay-admission-postgres.vitest.test.ts', expect: 32 },
  { name: 'eBay deletion review after acknowledgement (worker claims, first payload, RLS, atomic notices, races)', file: 'src/services/cx/ingress/ebay-erasure-review-postgres.vitest.test.ts', expect: 119 },
  { name: 'eBay deletion quarantine and read-only operator census (authority, retention, migration)', file: 'src/services/cx/ingress/ebay-deletion-quarantine-postgres.vitest.test.ts', expect: 11 },
  { name: 'private quarantine maintenance and inventory (roles, CAS, audit, snapshots and handoff races)', file: 'src/services/cx/ingress/ebay-quarantine-maintenance-postgres.vitest.test.ts', expect: 33 },
  { name: 'cold quarantine verification (closed snapshots, private body door, concurrent changes and CLI)', file: 'src/services/cx/ingress/ebay-quarantine-verification-postgres.vitest.test.ts', expect: 12 },
  { name: 'operator quarantine rewrap (audited CAS, closed transactions across KMS, contention and CLI)', file: 'src/services/cx/ingress/ebay-quarantine-rewrap-postgres.vitest.test.ts', expect: 7 },
  { name: 'mixed-version eBay rollout (held admission and atomic activation)', file: 'src/services/cx/ingress/ebay-rollout-postgres.vitest.test.ts', expect: 9 },
  { name: 'stored eBay execution (claims, holds, warnings, selection and worker integration)', file: 'src/services/cx/ingress/ebay-processing-postgres.vitest.test.ts', expect: 17 },
  { name: 'atomic grant versions (reconnect, rollback, inspection and concurrent replacement)', file: 'src/services/cx/grant-version-postgres.vitest.test.ts', expect: 10 },
  { name: 'eBay seller grant fence (cross-record reconnects and fresh committed reads)', file: 'src/services/cx/ebay-identity-postgres.vitest.test.ts', expect: 10 },
  { name: 'credential maintenance races (rotation, backfill, rollback and shared-account isolation)', file: 'src/services/cx/credential-writers-postgres.vitest.test.ts', expect: 12 },
  { name: 'transactional eBay revocation and unresolved owner warnings', file: 'src/services/cx/revocation-postgres.vitest.test.ts', expect: 25 },
  { name: 'durable webhook claims and retention', file: 'src/services/cx/ingress/claims.vitest.test.ts', expect: 22 },
  { name: 'one owner per inbound row type (eBay leases × processing claims, retention archive)', file: 'src/services/cx/ingress/inbound-ownership-postgres.vitest.test.ts', expect: 13 },
  { name: 'redelivery identity and bounded inbound retention (binding, reconnects, payload expiry by UPDATE)', file: 'src/services/cx/ingress/inbound-redelivery-retention-postgres.vitest.test.ts', expect: 7 },
  { name: 'transactional event producers and duplicate consumers', file: 'src/services/event-durability.vitest.test.ts', expect: 5 },
  { name: 'Etsy shop routing (backfill, ownership and identity namespaces)', file: 'src/services/etsy/ingress-routing-postgres.vitest.test.ts', expect: 5 },
  { name: 'Etsy receipt ingest (one writer: S1 per-product holds, whole-receipt take, partial notice, R5 dispositions, H1 activation, webhook defer/refusals, fair polling, lease, freshness)', file: 'src/services/etsy/etsy-order-ingest-postgres.vitest.test.ts', expect: 59 },
  { name: 'guarded connection delete (fresh counts and FK race)', file: 'src/services/connection-delete-concurrency.vitest.test.ts', expect: 2 },
  { name: 'Amazon Finances dry run and order attribution on the base schema (A2, A5; A3/A4 held)', file: 'src/services/amazon-finances-base-postgres.vitest.test.ts', expect: 9 },
  { name: 'stock race test (AE.1)', file: 'src/services/stock-concurrency.vitest.test.ts', expect: 10 },
  { name: 'an order line is taken once (re-reads, oversold lines, surplus holds and splits, reconcile, races; Amazon FBM, Shopify, MCF)', file: 'src/services/order-stock-once-postgres.vitest.test.ts', expect: 21 },
  { name: 'one stock model across channels (crash heal, multi-line totals, cancellation after shipment, races)', file: 'src/services/stock-model-postgres.vitest.test.ts', expect: 48 },
  { name: 'assortment copy test (AE.3)', file: 'src/services/assortment/copy-run.vitest.test.ts', expect: 8 },
  { name: 'shared stock race test (pool doors)', file: 'src/services/stock-pool/stock-pool-concurrency.vitest.test.ts', expect: 6 },
  { name: 'shared stock end to end (switches, worker, cascade)', file: 'src/services/stock-pool/stock-pool-e2e.vitest.test.ts', expect: 9 },
  { name: 'listing end times (Sync Control, the job, the database rule)', file: 'src/services/listing-end-times.vitest.test.ts', expect: 25 },
  { name: 'shared stock orders (sales, holds, cancellations, returns, repair, stock pages)', file: 'src/services/stock-pool/stock-pool-orders.vitest.test.ts', expect: 24 },
  { name: 'transactional eBay order writer (atomic lines and stock, shortfalls, races, locks, attribution)', file: 'src/services/ebay-order-writer-postgres.vitest.test.ts', expect: 32 },
  { name: 'eBay mixed own and pool stock (global Product locks, durable cancellation retries)', file: 'src/services/ebay-order-pool-postgres.vitest.test.ts', expect: 12 },
  { name: 'dormant eBay ORDER_CONFIRMATION execution (one read, own account, atomic receipt)', file: 'src/services/cx/ingress/ebay-order-processing-postgres.vitest.test.ts', expect: 13 },
  { name: 'order cancellation gives back what the order took at ingest, never shipped units (eBay, Amazon FBM/FBA, Shopify; markers, races, re-run, owner notice)', file: 'src/services/order-cancellation/order-cancellation-postgres.vitest.test.ts', expect: 17 },
  { name: 'live product sync (AE.4: capture, worker, overrides, images, SKU, variations, listener)', file: 'src/services/assortment/sync.vitest.test.ts', expect: 16 },
  { name: 'shared copy into a business with no marketplace (AE.3)', file: 'src/services/assortment/copy-unknown-market.vitest.test.ts', expect: 3 },
  { name: 'Link copy: variations inherit an attribute with no column in the receiving business (AE.3)', file: 'src/services/assortment/copy-inherited-attribute.vitest.test.ts', expect: 3 },
  { name: 'media plan layers (images rebuild P1: edits to one layer, compare-and-swap retry under a real race, account, alias and Amazon market checks)', file: 'src/services/images/media-plan.service.vitest.test.ts', expect: 20 },
  { name: 'product media pop-up save (Lane C: one save bound by expect; two pop-ups on one set or one list, one wins; a gallery save is announced)', file: 'src/services/images/media-popup-save.vitest.test.ts', expect: 4 },
  { name: 'price door race (product sheet Step 2.2 Gate 2, A-17 retry)', file: 'src/services/pim/price-door-concurrency.vitest.test.ts', expect: 11 },
  { name: 'draft listings race (product sheet create path step 2: two concurrent first saves create one set)', file: 'src/services/pim/draft-listing-postgres.vitest.test.ts', expect: 2 },
  { name: 'live listings race (step 7: two recorders, or a draft creator and a recorder, leave one live row)', file: 'src/services/pim/live-listing-postgres.vitest.test.ts', expect: 2 },
  { name: 'first theme save race (product sheet create path step 4: two concurrent version-0 saves, one draft, one 409)', file: 'src/services/pim/family-projection-postgres.vitest.test.ts', expect: 1 },
  { name: 'eBay price read-back dedupe (JSON-path key, classes, 24 h, per business)', file: 'src/services/ebay-price-readback-postgres.vitest.test.ts', expect: 4 },
  { name: 'master-price currency refusal (own transaction, caller rollback and commit)', file: 'src/services/master-price-currency-postgres.vitest.test.ts', expect: 3 },
  { name: 'pending readiness vs a concurrent rebuild (attributes P2)', file: 'src/services/pim/readiness-pending-race.vitest.test.ts', expect: 2 },
  { name: 'one sheet operation = one transaction (250 rows, one readiness rebuild, row savepoints, RLS, two operations at once)', file: 'src/services/products/bulk-save-postgres.vitest.test.ts', expect: 5 },
  { name: 'category tree races (moves, creates, memberships and workspace commands serialize on the tree lock)', file: 'src/services/category-tree-concurrency.vitest.test.ts', expect: 5 },
  { name: 'Amazon Ads drift closes on evidence, per profile (structural reconcile under row security)', file: 'src/services/advertising/ads-structural-reconcile-postgres.vitest.test.ts', expect: 1 },
  { name: '"New attribute" race (sheet pop-up A3: two creates of one name leave one attribute and one family link)', file: 'src/services/pim/own-axis-attribute-postgres.vitest.test.ts', expect: 1 },
  { name: 'Shopify sheet draft saves racing (Lane B: one winner per cell, nothing lost, a refused save is not in the draft)', file: 'src/services/shopify/channel-sheet-race-postgres.vitest.test.ts', expect: 2 },
]
const IMAGES = ['pgvector/pgvector:pg17', 'postgres:17', 'postgres:17-alpine']
const DEAD = 'postgresql://nobody@127.0.0.1:1/real_pg_no_stray_writes_test'

const docker = (...cmd) => execFileSync('docker', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim()

function skip(reason) {
  console.log(`⚠ real-PostgreSQL tests SKIPPED — ${reason}. They prove no stock update is lost under concurrency and that a shared-product copy completes end to end; run them where Docker is available.`)
  // In CI, or with --required, a skip measured nothing and must fail (docs/ci-plan.md §2.3).
  process.exit(args.includes('--required') || process.env.CI === 'true' ? 1 : 0)
}

try { docker('info', '--format', '{{.ServerVersion}}') } catch { skip('Docker is not available here') }
const image = IMAGES.find((name) => { try { docker('image', 'inspect', name); return true } catch { return false } })
if (!image) skip(`no PostgreSQL 17 image on this machine (docker pull ${IMAGES[0]})`)

const name = `nexus-real-pg-${process.pid}`
const reportDir = mkdtempSync(join(tmpdir(), 'nexus-real-pg-'))
let started = false
let preserveEvidence = false
const stop = () => {
  if (started) {
    started = false
    try { docker('stop', name) } catch { /* already gone */ }
  }
  if (!preserveEvidence) rmSync(reportDir, { recursive: true, force: true })
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
  // --owner production: the suites connect as a NON-superuser that bypasses row security — the rights
  // production's migration role was measured with (neondb_owner: rolsuper false, rolbypassrls true) — so
  // every door, trigger and policy is created and run without a superuser (shared stock plan risk 8).
  const owner = flag('--owner') ?? 'production'
  if (!['superuser', 'production'].includes(owner)) { console.error(`❌ --owner must be superuser or production, not ${owner}`); process.exit(1) }
  const user = owner === 'production' ? 'nexus_owner' : 'postgres'
  if (owner === 'production') {
    for (let i = 0; i < 20; i++) {
      try { docker('exec', name, 'psql', '-U', 'postgres', '-h', '127.0.0.1', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE ROLE nexus_owner LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE'); break }
      catch (error) { if (i === 19) throw error; spawnSync('sleep', ['0.5']) }
    }
    console.log('real-PostgreSQL tests run as nexus_owner (NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE)')
  }

  const reportPath = join(reportDir, 'report.json')
  const run = spawnSync('npx', ['vitest', 'run', ...SUITES.map((suite) => suite.file), '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`], {
    cwd: API,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEXUS_TEST_CONCURRENT_PG_URL: `postgresql://${user}@127.0.0.1:${port}/postgres`,
      DATABASE_URL: DEAD,
      DIRECT_URL: DEAD,
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    // 15 minutes. At 10 the CI step ran 9 m 41 s – 9 m 58 s on most runs of 2026-09-28 (database start included), so
    // a slow runner timed out with no test failed: one PR check and one deploy that day. The job's own 20-minute limit
    // still holds, and a real hang still ends the run.
    timeout: 900_000,
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
    const ok = file?.status === 'passed' && passed === suite.expect && failed === 0 && skipped === 0
    const detail = file ? `${passed} passed, ${failed} failed, ${skipped} skipped; suite ${file.status}` : 'not in the report'
    return { suite, ok, line: `${suite.name}: ${detail} (expected ${suite.expect} passed)` }
  })

  if (run.status === 0 && report && verdicts.every((v) => v.ok)) {
    for (const v of verdicts) console.log(`✓ ${v.line}`)
    console.log(`✓ real-PostgreSQL tests passed (throwaway PostgreSQL, ${image})`)
    process.exit(0)
  }
  console.error(`❌ real-PostgreSQL tests FAILED — vitest exit ${run.status}${report ? '' : '; no JSON report was written'}`)
  for (const v of verdicts) console.error(`${v.ok ? '  ✓' : '  ✗'} ${v.line}`)
  preserveEvidence = true
  writeFileSync(join(reportDir, 'output.log'), output)
  for (const file of report?.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') console.error(`FAILED TEST: ${assertion.fullName}\n${(assertion.failureMessages ?? []).join('\n')}`)
    }
  }
  console.error(`Full local test evidence retained at ${reportDir}`)
  // A disposable database's teardown logs the backends that blocked its DROP on one line (concurrent-database.ts).
  for (const line of output.split('\n').filter((l) => l.includes('[real-pg] '))) console.error(line)
  // Hook failures can leave every assertion green and JSON's file.message empty.
  // Surface the actual failure before ordinary application/Redis log noise.
  const hookFailure = output.indexOf('Failed Suites')
  if (hookFailure >= 0) console.error(output.slice(hookFailure).split('\n').slice(0, 40).join('\n'))
  console.error(output.split('\n').filter((l) => /FAIL|AssertionError|Error:|expected|skipped/.test(l)).slice(0, 40).join('\n'))
  process.exit(1)
} finally {
  stop()
}
