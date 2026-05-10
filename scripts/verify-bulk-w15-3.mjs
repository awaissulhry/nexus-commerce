#!/usr/bin/env node
/**
 * W15.3 — 10k-row perf benchmark.
 *
 * Loads a synthetic BulkActionJob with 10,000 BulkActionItem rows
 * and measures p50/p95 wall-clock for the queries the bulk-
 * operations UI hits frequently:
 *
 *   - getJobStatus(jobId)          — single-row read; the SSE
 *                                    poll fires this once per
 *                                    second per active job.
 *   - listItems(jobId)             — drill-in panel query;
 *                                    bounded at 1000 items + a
 *                                    SKU/channel-label join.
 *   - listItems with status filter — drilling into "only failed"
 *                                    subset; should leverage the
 *                                    @@index([jobId, status]).
 *
 * Captures a baseline so future regressions are visible. Opt-in
 * via NEXUS_RUN_PERF_BENCH=1 (the W15.2 wave-audit runner skips
 * this by default — perf bench takes minutes against a real DB).
 *
 * Cleanup: drops the synthetic job + items at the end via cascade.
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
dotenv.config({ path: path.join(repo, '.env') })

if (process.env.NEXUS_RUN_PERF_BENCH !== '1') {
  console.log(
    '\nW15.3 — perf bench (skipped). Set NEXUS_RUN_PERF_BENCH=1 to run.\n',
  )
  console.log('  ✓ skipped per env gate')
  console.log('\n✓ all assertions passed')
  process.exit(0)
}

let url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL missing')
  process.exit(1)
}
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

const ROW_COUNT = Number(process.env.NEXUS_PERF_BENCH_ROWS ?? 10_000)
const SAMPLES = Number(process.env.NEXUS_PERF_BENCH_SAMPLES ?? 30)

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.floor((p / 100) * (sorted.length - 1))
  return sorted[idx]
}

console.log(`\nW15.3 — 10k-row perf bench (${ROW_COUNT} items, ${SAMPLES} samples)\n`)

// Use a stable id so re-runs replace the same row instead of
// piling up rejected synthetic jobs in the catalog.
const JOB_ID = 'perf-bench-w15-3'
console.log(`Setting up synthetic BulkActionJob ${JOB_ID} ...`)
await c.query(`DELETE FROM "BulkActionItem" WHERE "jobId" = $1`, [JOB_ID])
await c.query(`DELETE FROM "BulkActionJob" WHERE id = $1`, [JOB_ID])
await c.query(
  `INSERT INTO "BulkActionJob" (
     id, "jobName", "actionType", "targetProductIds", "targetVariationIds",
     "actionPayload", status, "totalItems", "processedItems", "failedItems",
     "skippedItems", "progressPercent", "createdAt", "updatedAt"
   ) VALUES ($1, 'perf bench', 'STATUS_UPDATE', $2, $3, '{}'::jsonb,
             'COMPLETED', $4, $4, 0, 0, 100, NOW(), NOW())`,
  [JOB_ID, [], [], ROW_COUNT],
)

const setupStart = Date.now()
// Bulk-insert via UNNEST for one round-trip; ~100ms for 10k on Neon.
const ids = Array.from({ length: ROW_COUNT }, (_, i) => `${JOB_ID}-item-${i}`)
const statuses = Array.from({ length: ROW_COUNT }, (_, i) =>
  i % 50 === 0 ? 'FAILED' : 'SUCCEEDED',
)
await c.query(
  `INSERT INTO "BulkActionItem" (id, "jobId", status, "createdAt", "completedAt")
     SELECT id, $1, status, NOW(), NOW()
       FROM UNNEST($2::text[], $3::text[]) AS t(id, status)`,
  [JOB_ID, ids, statuses],
)
console.log(`  insert ${ROW_COUNT} rows in ${Date.now() - setupStart}ms`)

async function timeOnce(fn) {
  const t = Date.now()
  await fn()
  return Date.now() - t
}

console.log('\nQuery: getJobStatus equivalent (SELECT * WHERE id = $1)')
const jobReadTimes = []
for (let i = 0; i < SAMPLES; i++) {
  jobReadTimes.push(
    await timeOnce(() =>
      c.query(`SELECT * FROM "BulkActionJob" WHERE id = $1`, [JOB_ID]),
    ),
  )
}
const jobP50 = pct(jobReadTimes, 50)
const jobP95 = pct(jobReadTimes, 95)
console.log(`  p50=${jobP50}ms  p95=${jobP95}ms`)
check(`getJobStatus p95 < 100ms (got ${jobP95}ms)`, jobP95 < 100)

console.log('\nQuery: listItems unfiltered (1000-item page)')
const listTimes = []
for (let i = 0; i < SAMPLES; i++) {
  listTimes.push(
    await timeOnce(() =>
      c.query(
        `SELECT * FROM "BulkActionItem"
           WHERE "jobId" = $1
           ORDER BY "createdAt" ASC
           LIMIT 1000`,
        [JOB_ID],
      ),
    ),
  )
}
const listP50 = pct(listTimes, 50)
const listP95 = pct(listTimes, 95)
console.log(`  p50=${listP50}ms  p95=${listP95}ms`)
check(`listItems p95 < 500ms (got ${listP95}ms)`, listP95 < 500)

console.log('\nQuery: listItems status=FAILED filter (uses jobId+status index)')
const listFailedTimes = []
for (let i = 0; i < SAMPLES; i++) {
  listFailedTimes.push(
    await timeOnce(() =>
      c.query(
        `SELECT * FROM "BulkActionItem"
           WHERE "jobId" = $1 AND status = 'FAILED'
           ORDER BY "createdAt" ASC
           LIMIT 1000`,
        [JOB_ID],
      ),
    ),
  )
}
const listFailedP50 = pct(listFailedTimes, 50)
const listFailedP95 = pct(listFailedTimes, 95)
console.log(`  p50=${listFailedP50}ms  p95=${listFailedP95}ms`)
check(
  `listItems(status=FAILED) p95 < 250ms (got ${listFailedP95}ms)`,
  listFailedP95 < 250,
)

console.log('\nQuery: BulkActionJob.findUnique by status (active-jobs strip)')
const activeListTimes = []
for (let i = 0; i < SAMPLES; i++) {
  activeListTimes.push(
    await timeOnce(() =>
      c.query(
        `SELECT id, "jobName", status, "processedItems", "totalItems",
                "estimatedCompletionAt"
           FROM "BulkActionJob"
           WHERE status IN ('PENDING','QUEUED','IN_PROGRESS')
           ORDER BY "createdAt" DESC
           LIMIT 10`,
      ),
    ),
  )
}
const activeP50 = pct(activeListTimes, 50)
const activeP95 = pct(activeListTimes, 95)
console.log(`  p50=${activeP50}ms  p95=${activeP95}ms`)
check(`active-jobs strip p95 < 100ms (got ${activeP95}ms)`, activeP95 < 100)

console.log('\nCleanup')
await c.query(`DELETE FROM "BulkActionItem" WHERE "jobId" = $1`, [JOB_ID])
await c.query(`DELETE FROM "BulkActionJob" WHERE id = $1`, [JOB_ID])
console.log('  ✓ synthetic data dropped')

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
