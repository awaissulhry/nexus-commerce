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
 *   · `stock-pool-sku-e2e.vitest.test.ts` (shared stock by SKU, 2026-10-01) — connect by the same SKU with no
 *     product share, every listing kind, and the worker woken by the database's LISTEN/NOTIFY within 2 s of a sale.
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
 *   · `routes/mcp-cross-business-postgres.vitest.test.ts` (MCP.8, 2026-09-30) — Claude's connection for one business
 *     never reaches another: the /mcp route, the Approvals and Connected apps routes and every tool, run as the
 *     restricted runtime login, so row-level security holds exactly as it does in production.
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
 * PARTS (CI, 2026-09-30)
 *   In one CI job the suites took about 10.5 minutes (median of 15 runs, 2026-09-29): the longest step of every
 *   deploy. `--part N/M` runs one of M parts, so M jobs run side by side. The split is the API shards' split
 *   (scripts/ci/api-test-plan.mjs): longest suite first, each to the lightest part, by the times in
 *   scripts/ci/real-postgres-durations.json. Part 1 starts with a head start for the steps only it runs
 *   (PART_ONE_HEAD_START), so the jobs, not only their suites, end together.
 *   The same commit gives the same split on every machine, so the M jobs together run every suite once.
 *   Before any container starts, the split is checked. A suite in no part or in two, a suite listed twice,
 *   a suite whose name or expected count changed, or an empty part is REFUSED. Each suite keeps its "expect".
 *   CI takes M from the size of its matrix and records what each part passed (--record); db-security then
 *   checks that the parts together passed every suite once. A matrix that loses a part cannot stay green.
 *
 *   node scripts/run-real-postgres-tests.mjs                     # production-equivalent owner by default
 *   node scripts/run-real-postgres-tests.mjs --owner production   # as a non-superuser owner, production's rights
 *   node scripts/run-real-postgres-tests.mjs --required           # CI: missing Docker or image FAILS instead of skipping
 *   node scripts/run-real-postgres-tests.mjs --part 1/2           # CI: one of two parts (see PARTS)
 *   node scripts/run-real-postgres-tests.mjs --part 1/2 --list    # print that part's files and expected counts; no Docker
 *   node scripts/run-real-postgres-tests.mjs --record <file>      # after a pass: write each suite's file and passed count, as --list does
 *   node scripts/run-real-postgres-tests.mjs --write-durations    # after a whole run: average its times into those --part uses
 *   node scripts/run-real-postgres-tests.mjs --self-test          # the split check refuses planted faults (a static gate)
 *   node scripts/run-real-postgres-tests.mjs --suites '[{"name":"x","file":"src/…","expect":1}]'   # harness use
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shards } from './ci/api-test-plan.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = `${ROOT}/apps/api`
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const SUITES = flag('--suites') ? JSON.parse(flag('--suites')) : [
  { name: 'Shopify colour sync (durable debounce, rollback, claims and stale completion)', file: 'src/services/shopify/colour-products/sync-postgres.vitest.test.ts', expect: 11 },
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
  { name: 'shared stock by SKU end to end (no product share: connect by SKU, every listing, real-time wake under 2 s, D1 SKU lock, disconnect)', file: 'src/services/stock-pool/stock-pool-sku-e2e.vitest.test.ts', expect: 7 },
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
  { name: 'transaction commit conflict (real adapter error, fresh snapshot and committed effects)', file: 'src/lib/database-context-postgres.vitest.test.ts', expect: 1 },
  { name: 'one sheet operation = one transaction (250 rows, one readiness rebuild, row savepoints, RLS, two operations at once)', file: 'src/services/products/bulk-save-postgres.vitest.test.ts', expect: 5 },
  { name: 'category tree races (moves, creates, memberships and workspace commands serialize on the tree lock)', file: 'src/services/category-tree-concurrency.vitest.test.ts', expect: 5 },
  { name: 'Amazon Ads drift closes on evidence, per profile (structural reconcile under row security)', file: 'src/services/advertising/ads-structural-reconcile-postgres.vitest.test.ts', expect: 1 },
  { name: '"New attribute" race (sheet pop-up A3: two creates of one name leave one attribute and one family link)', file: 'src/services/pim/own-axis-attribute-postgres.vitest.test.ts', expect: 1 },
  { name: 'Shopify sheet draft saves racing (Lane B: one winner per cell, nothing lost, a refused save is not in the draft)', file: 'src/services/shopify/channel-sheet-race-postgres.vitest.test.ts', expect: 2 },
  { name: 'Claude for one business never reaches another (MCP.8: every tool with the other business\'s ids, header and query, membership, role, revocation, approvals, tool policy, canary scan)', file: 'src/routes/mcp-cross-business-postgres.vitest.test.ts', expect: 17 },
]
const IMAGES = ['pgvector/pgvector:pg17', 'postgres:17', 'postgres:17-alpine']
const DEAD = 'postgresql://nobody@127.0.0.1:1/real_pg_no_stray_writes_test'
const DURATIONS = join(ROOT, 'scripts', 'ci', 'real-postgres-durations.json')

/** Measured wall milliseconds per suite file; used only to balance --part. A suite with no entry counts as 1 s. */
function measured() {
  return existsSync(DURATIONS) ? JSON.parse(readFileSync(DURATIONS, 'utf8')).files ?? {} : {}
}

// Part 1 also runs the postgres job's one-off steps (ci.yml): durability off and the image pull ~4 s, RBAC coverage
// ~8 s, the migration upgrade check ~11 s, the database package ~9 s (medians of 15 CI runs, 2026-09-29). Their 32 s
// are 5 % of the 630 s the suites took in the same runs (median), so part 1 starts the split with 32/630 of the
// suites' total. A share, not seconds: the stored times are local, and a refresh on a faster or slower machine
// scales them all. Moving a step between parts, or a step that becomes much slower, means changing this number.
const PART_ONE_HEAD_START = 32 / 630

/** `count` parts of `suites`, balanced by `weights`, part 1 with its head start; each part keeps the SUITES order. */
function split(suites, count, weights) {
  const files = suites.map((suite) => suite.file)
  const headStart = PART_ONE_HEAD_START * files.reduce((sum, file) => sum + (weights[file] ?? 1000), 0) // 1 s: as shards()
  return shards(files, count, weights, [headStart]).map((bin) => suites.filter((suite) => bin.files.includes(suite.file)))
}

/** What is wrong with `parts` as a split of `suites`: every suite must be in exactly one part, unchanged. */
function checkParts(suites, parts) {
  const problems = []
  const same = (a, b) => a.name === b.name && a.file === b.file && a.expect === b.expect
  for (const [i, part] of parts.entries()) if (part.length === 0) problems.push(`part ${i + 1}/${parts.length} has no suites`)
  // One line per suite file. A file listed twice is placed once per copy, so its placement says nothing more:
  // the duplicate is the fault, and its line names the parts it reached.
  for (const file of new Set(suites.map((suite) => suite.file))) {
    const copies = suites.filter((suite) => suite.file === file).length
    const where = parts.flatMap((part, i) => part.filter((s) => s.file === file).map(() => i + 1))
    const distinct = [...new Set(where)]
    const named = distinct.length > 1 ? `parts ${distinct.join(' and ')}` : `part ${distinct[0]}`
    if (copies > 1) problems.push(`listed ${copies} times in SUITES${where.length ? ` (placed in ${named})` : ''}: ${file}`)
    else if (where.length === 0) problems.push(`in no part: ${file}`)
    else if (where.length > 1) problems.push(`in ${where.length} places (${named}): ${file}`)
  }
  for (const suite of parts.flat()) {
    const listed = suites.find((s) => s.file === suite.file)
    if (!listed) problems.push(`in a part but not in SUITES: ${suite.file}`)
    else if (!same(listed, suite)) problems.push(`name or expected count changed on the way: ${suite.file}`)
  }
  return [...new Set(problems)]
}

const expected = (suites) => suites.reduce((sum, suite) => sum + suite.expect, 0)

// Proves the check refuses each kind of bad split, on the real list. A static gate (scripts/ci/run-static-gates.mjs).
if (args.includes('--self-test')) {
  const weights = measured()
  const failures = []
  for (const count of [1, 2, 3, 4]) {
    const problems = checkParts(SUITES, split(SUITES, count, weights))
    if (problems.length) failures.push(`the real split into ${count} was refused: ${problems.join('; ')}`)
  }
  if (JSON.stringify(split(SUITES, 2, weights)) !== JSON.stringify(split(SUITES, 2, weights))) failures.push('two splits of one list differ')
  const [one, two] = split(SUITES, 2, weights)
  const doubled = [...SUITES, SUITES[0]]
  const planted = {
    'a suite listed twice': [doubled, [one, two]],
    'a suite in no part': [SUITES, [one, two.slice(1)]],
    'a suite in both parts': [SUITES, [one, [...two, one[0]]]],
    'a suite twice in one part': [SUITES, [[...one, one[0]], two]],
    'a changed expected count': [SUITES, [[{ ...one[0], expect: one[0].expect + 1 }, ...one.slice(1)], two]],
    'a suite not in SUITES': [SUITES, [[...one, { ...one[0], file: `${one[0].file}.planted` }], two]],
    'an empty part': [SUITES.slice(0, 1), split(SUITES.slice(0, 1), 2, weights)],
  }
  for (const [fault, [suites, parts]] of Object.entries(planted)) if (checkParts(suites, parts).length === 0) failures.push(`not refused: ${fault}`)
  // A duplicate is placed once per copy; the refusal still names it on ONE line.
  const lines = checkParts(doubled, split(doubled, 2, weights)).filter((p) => p.endsWith(`: ${SUITES[0].file}`))
  if (lines.length !== 1) failures.push(`a suite listed twice gave ${lines.length} lines, not 1: ${lines.join(' | ')}`)
  if (failures.length) { console.error(`❌ real-PostgreSQL split self-test:\n${failures.map((f) => `  ${f}`).join('\n')}`); process.exit(1) }
  console.log(`✓ real-PostgreSQL split self-test: splits into 1–4 parts hold all ${SUITES.length} suites once; ${Object.keys(planted).length} planted faults refused`)
  process.exit(0)
}

// Which suites THIS run owns. Checked before Docker, so a bad split fails even where Docker is missing.
const partArg = args.includes('--part') ? /^(\d+)\/(\d+)$/.exec(flag('--part') ?? '') : null
const part = partArg ? { index: Number(partArg[1]), count: Number(partArg[2]) } : null
if (args.includes('--part') && !(part && part.index >= 1 && part.index <= part.count)) {
  console.error(`❌ --part must look like n/m (part n of m, e.g. 1/2), got ${flag('--part') ?? 'nothing'}`)
  process.exit(1)
}
const record = flag('--record')
if (args.includes('--record') && !(record && !record.startsWith('--'))) {
  console.error(`❌ --record needs a file to write, got ${record ?? 'nothing'}`)
  process.exit(1)
}
if (args.includes('--write-durations') && (part || flag('--suites'))) {
  console.error('❌ --write-durations needs a whole run of SUITES (no --part, no --suites): times from a part would change the split the other parts read')
  process.exit(1)
}
const parts = split(SUITES, part?.count ?? 1, measured())
const problems = checkParts(SUITES, parts)
if (problems.length) {
  console.error(`❌ real-PostgreSQL tests REFUSED — the split does not run every suite exactly once:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
const RUN = parts[(part?.index ?? 1) - 1]
if (args.includes('--list')) {
  for (const suite of RUN) console.log(`${suite.file}\t${suite.expect}`)
  process.exit(0)
}
if (part) console.log(`real-PostgreSQL part ${part.index}/${part.count}: ${RUN.length} of ${SUITES.length} suites, ${expected(RUN)} of ${expected(SUITES)} expected passes`)

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
  const run = spawnSync('npx', ['vitest', 'run', ...RUN.map((suite) => suite.file), '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`], {
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

  // A suite's wall time: its tests plus the import and setup before them. The suites run one after another, so
  // this is the time from the previous suite's end to its own; vitest's per-file time leaves out the import and
  // setup, a third of the run measured 2026-09-30 (186 of 558 s). The time is on each ✓ line, so a CI log shows how
  // even the parts really are. Only --write-durations, after a whole local run, changes the times the split reads.
  const wall = new Map()
  let previousEnd = report?.startTime ?? 0
  for (const result of [...(report?.testResults ?? [])].sort((a, b) => a.startTime - b.startTime)) {
    wall.set(resolve(result.name), Math.max(0, Math.round(result.endTime - previousEnd)))
    previousEnd = result.endTime
  }

  const verdicts = RUN.map((suite) => {
    const file = report?.testResults?.find((result) => resolve(result.name) === resolve(API, suite.file))
    const statuses = file?.assertionResults?.map((test) => test.status) ?? []
    const count = (status) => statuses.filter((s) => s === status).length
    const passed = count('passed'), failed = count('failed'), skipped = statuses.length - passed - failed
    const ok = file?.status === 'passed' && passed === suite.expect && failed === 0 && skipped === 0
    const detail = file ? `${passed} passed, ${failed} failed, ${skipped} skipped; suite ${file.status}` : 'not in the report'
    const ms = wall.get(resolve(API, suite.file)) ?? 0
    return { suite, ok, ms, passed, line: `${suite.name}: ${detail} (expected ${suite.expect} passed; ${(ms / 1000).toFixed(1)} s)` }
  })

  if (run.status === 0 && report && verdicts.every((v) => v.ok)) {
    for (const v of verdicts) console.log(`✓ ${v.line}`)
    console.log(`✓ real-PostgreSQL tests passed (throwaway PostgreSQL, ${image})${part ? ` — part ${part.index}/${part.count}, ${RUN.length} suites, ${expected(RUN)} passes` : ''}`)
    if (record) {
      // The same lines as --list, so db-security can compare the parts' records with the whole list.
      writeFileSync(record, verdicts.map((v) => `${v.suite.file}\t${v.passed}\n`).join(''))
      console.log(`✓ recorded ${verdicts.length} passed suites in ${record}`)
    }
    if (args.includes('--write-durations')) {
      // One run is not enough: local times move with the machine's load. On 2026-09-30 the same 55 suites took 558 s,
      // then 331 s, and a split from one run was 58/42 by the other's times; from both averaged, 51/49 by either.
      // So a refresh averages this run with the stored times, the stored ones scaled to this run's total: the newest
      // run weighs half, the one before a quarter, and so on. A suite new to the file takes this run's time.
      const stored = measured()
      const known = verdicts.filter((v) => stored[v.suite.file] > 0)
      const scale = known.reduce((sum, v) => sum + v.ms, 0) / (known.reduce((sum, v) => sum + stored[v.suite.file], 0) || 1)
      const time = (v) => (stored[v.suite.file] > 0 ? Math.round((v.ms + stored[v.suite.file] * scale) / 2) : v.ms)
      const files = Object.fromEntries(verdicts.map((v) => [v.suite.file, time(v)]).sort(([a], [b]) => a.localeCompare(b)))
      const note = 'Per-suite wall time (ms), import and setup included, from whole local real-PostgreSQL runs; only used to balance --part. Each --write-durations refresh averages its run with the stored times, so the newest run weighs half. measuredAt is the UTC time of the last refresh.'
      writeFileSync(DURATIONS, `${JSON.stringify({ '//': note, measuredAt: `${new Date().toISOString().slice(0, 16)}Z`, files }, null, 2)}\n`)
      console.log(`✓ wrote ${verdicts.length} suite times to ${relative(ROOT, DURATIONS)} (${known.length} averaged with the stored times)`)
    }
    process.exit(0)
  }
  console.error(`❌ real-PostgreSQL tests FAILED${part ? ` (part ${part.index}/${part.count})` : ''} — vitest exit ${run.status}${report ? '' : '; no JSON report was written'}`)
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
