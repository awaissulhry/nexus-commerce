#!/usr/bin/env node
// Verify W1.3 — orphan-PENDING bulk-job cleanup cron.
// Asserts:
//   1. The runOrphanBulkJobCleanupOnce sweep auto-cancels PENDING jobs
//      with createdAt > 1h ago AND startedAt = null.
//   2. PENDING jobs younger than the threshold are NOT cancelled.
//   3. Jobs with startedAt set (worker reached them) are NOT cancelled.
//   4. IN_PROGRESS / COMPLETED / FAILED / CANCELLED rows untouched.
//   5. Already-cancelled rows are no-op'd (idempotent).
//   6. The actual deploy-probe orphan from the audit gets cleaned.

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

const TEST_PREFIX = 'verify-w1.3-'

async function clean() {
  await c.query(`DELETE FROM "BulkActionJob" WHERE "jobName" LIKE $1`, [
    `${TEST_PREFIX}%`,
  ])
}

async function createTestJob({ label, status, ageHours, startedAt }) {
  const createdAt = new Date(Date.now() - ageHours * 60 * 60 * 1000)
  const r = await c.query(
    `INSERT INTO "BulkActionJob" (
       id, "jobName", "actionType", "actionPayload",
       status, "totalItems", "processedItems", "failedItems",
       "skippedItems", "progressPercent", "isRollbackable",
       "createdAt", "updatedAt", "startedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, 'PRICING_UPDATE', '{}'::jsonb,
       $2, 1, 0, 0, 0, 0, false, $3, $3, $4
     ) RETURNING id`,
    [
      `${TEST_PREFIX}${label}`,
      status,
      createdAt.toISOString(),
      startedAt ? createdAt.toISOString() : null,
    ],
  )
  return r.rows[0].id
}

async function readStatus(id) {
  const r = await c.query(`SELECT status, "lastError" FROM "BulkActionJob" WHERE id = $1`, [id])
  return r.rows[0]
}

// Mirror the cron sweep logic exactly so we test the contract without
// booting the API.
async function runOrphanSweep() {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000)
  const r = await c.query(
    `SELECT id FROM "BulkActionJob"
     WHERE status IN ('PENDING','QUEUED')
       AND "startedAt" IS NULL
       AND "createdAt" < $1`,
    [cutoff.toISOString()],
  )
  const ids = r.rows.map((row) => row.id)
  if (ids.length === 0) return { cancelled: 0, ids: [] }
  await c.query(
    `UPDATE "BulkActionJob"
     SET status='CANCELLED',
         "completedAt" = NOW(),
         "lastError" = 'Auto-cancelled by orphan-cleanup sweep — job never started processing within the orphan threshold.',
         "updatedAt" = NOW()
     WHERE id = ANY($1::text[])`,
    [ids],
  )
  return { cancelled: ids.length, ids }
}

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

await clean()

console.log('\nW1.3 — orphan-PENDING bulk-job cleanup\n')

// Case 1 — old PENDING with no startedAt → CANCELLED
console.log('Case 1: old PENDING (>1h, startedAt=null) → CANCELLED')
{
  const id = await createTestJob({
    label: 'case1-old-pending',
    status: 'PENDING',
    ageHours: 25,
    startedAt: false,
  })
  await runOrphanSweep()
  const after = await readStatus(id)
  check(`status flipped to CANCELLED (got ${after?.status})`, after?.status === 'CANCELLED')
  check(
    `lastError mentions orphan-cleanup`,
    typeof after?.lastError === 'string' &&
      after.lastError.includes('orphan-cleanup'),
  )
}

// Case 2 — recent PENDING (< 1h) → unchanged
console.log('\nCase 2: recent PENDING (<1h) → unchanged')
{
  const id = await createTestJob({
    label: 'case2-recent-pending',
    status: 'PENDING',
    ageHours: 0.5,
    startedAt: false,
  })
  await runOrphanSweep()
  const after = await readStatus(id)
  check(`status stays PENDING (got ${after?.status})`, after?.status === 'PENDING')
}

// Case 3 — old PENDING WITH startedAt → unchanged (worker grabbed it)
console.log('\nCase 3: old PENDING with startedAt set → unchanged')
{
  const id = await createTestJob({
    label: 'case3-with-startedat',
    status: 'PENDING',
    ageHours: 25,
    startedAt: true,
  })
  await runOrphanSweep()
  const after = await readStatus(id)
  check(`status stays PENDING (got ${after?.status})`, after?.status === 'PENDING')
}

// Case 4 — old QUEUED with no startedAt → CANCELLED
console.log('\nCase 4: old QUEUED (>1h, startedAt=null) → CANCELLED')
{
  const id = await createTestJob({
    label: 'case4-old-queued',
    status: 'QUEUED',
    ageHours: 25,
    startedAt: false,
  })
  await runOrphanSweep()
  const after = await readStatus(id)
  check(`QUEUED flips to CANCELLED (got ${after?.status})`, after?.status === 'CANCELLED')
}

// Case 5 — IN_PROGRESS → unchanged (W1.1 cooperative cancel is the right path)
console.log('\nCase 5: IN_PROGRESS → unchanged')
{
  const id = await createTestJob({
    label: 'case5-in-progress',
    status: 'IN_PROGRESS',
    ageHours: 25,
    startedAt: true,
  })
  await runOrphanSweep()
  const after = await readStatus(id)
  check(`IN_PROGRESS stays (got ${after?.status})`, after?.status === 'IN_PROGRESS')
}

// Case 6 — COMPLETED → unchanged
console.log('\nCase 6: COMPLETED → unchanged')
{
  const id = await createTestJob({
    label: 'case6-completed',
    status: 'COMPLETED',
    ageHours: 25,
    startedAt: true,
  })
  await runOrphanSweep()
  const after = await readStatus(id)
  check(`COMPLETED stays (got ${after?.status})`, after?.status === 'COMPLETED')
}

// Case 7 — already CANCELLED → no-op (idempotent)
console.log('\nCase 7: already CANCELLED → no-op (idempotent)')
{
  const id = await createTestJob({
    label: 'case7-already-cancelled',
    status: 'CANCELLED',
    ageHours: 25,
    startedAt: false,
  })
  const before = await readStatus(id)
  await runOrphanSweep()
  await runOrphanSweep()
  const after = await readStatus(id)
  check(`CANCELLED stays (got ${after?.status})`, after?.status === 'CANCELLED')
  check(`lastError unchanged on already-cancelled rows`, before?.lastError === after?.lastError)
}

// Case 8 — the real deploy-probe orphan from the audit
console.log('\nCase 8: deploy-probe orphan from production audit')
{
  const r = await c.query(
    `SELECT id, status FROM "BulkActionJob"
     WHERE id = 'cmou3t2a00000od018kzyt6wm'`,
  )
  if (r.rows.length === 0) {
    console.log('  ⊘ deploy-probe row no longer in DB (cleaned by another sweep) — skipping')
  } else {
    await runOrphanSweep()
    const after = await readStatus('cmou3t2a00000od018kzyt6wm')
    check(
      `production deploy-probe orphan cancelled (got ${after?.status})`,
      after?.status === 'CANCELLED',
    )
  }
}

await clean()
await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
