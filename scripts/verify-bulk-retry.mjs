#!/usr/bin/env node
// Verify the retry-failed-items endpoint.
//
// Strategy: create a bulk PRICING_UPDATE job with a deliberately-bogus
// payload (missing adjustmentType) so the handler throws on every
// item → all items get FAILED status → call retry-failed → assert
// the new job is created with the same shape, scoped to the failed
// productIds.
//
// We don't assert the retry succeeds (it'll fail again with the
// same payload — that's expected). We assert the retry-creation
// path works, since that's what this commit ships.
//
// Cleanup deletes both jobs (cascade takes their items).
//
// Usage:
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
//     node scripts/verify-bulk-retry.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

let pass = 0
let fail = 0
const failures = []
const createdJobIds = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

async function api(method, p, body) {
  const opts = { method }
  if (body != null) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API_BASE}${p}`, opts)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

async function pollJob(jobId, timeoutMs = 60000) {
  const start = Date.now()
  const terminal = new Set(['COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED', 'CANCELLED'])
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/api/bulk-operations/${jobId}`)
    if (r.ok && r.data?.job && terminal.has(r.data.job.status)) return r.data.job
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error(`pollJob timeout for ${jobId}`)
}

let target

try {
  // ── Setup: pick test product ──────────────────────────────────────
  const candidate = (await client.query(`
    SELECT p.id, p.sku FROM "Product" p
    INNER JOIN "ChannelListing" cl ON cl."productId" = p.id
    WHERE p."isParent" = false AND p."basePrice" IS NOT NULL AND p."basePrice" > 0
    ORDER BY p."updatedAt" DESC LIMIT 1
  `)).rows[0]
  if (!candidate) {
    console.log('No suitable test product found. Aborting.')
    process.exit(1)
  }
  target = candidate
  console.log(`Using product ${target.sku}`)

  // ── 1. Create a job that will FAIL on processing ──────────────────
  // Bogus actionPayload (missing adjustmentType) → handler throws →
  // all items end up FAILED.
  const create = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-retry-bogus',
    actionType: 'PRICING_UPDATE',
    targetProductIds: [target.id],
    actionPayload: { value: 5.0 }, // missing adjustmentType
  })
  if (!create.ok) {
    bad('Setup: create job', `status=${create.status}`)
    throw new Error('cannot continue')
  }
  createdJobIds.push(create.data.job.id)
  await api('POST', `/api/bulk-operations/${create.data.job.id}/process`)
  const j1 = await pollJob(create.data.job.id)
  if (j1.failedItems === 1 && j1.status === 'FAILED') {
    ok(`Original job FAILED with 1 failed item (setup correct)`)
  } else {
    bad('Setup: expected FAILED job', `status=${j1.status} failed=${j1.failedItems}`)
  }

  // ── 2. Trying retry-failed on a job with 0 failed items returns 409 ─
  // (We'd need a successful job for this; skip — covered by 4 below.)

  // ── 3. retry-failed creates a new job ─────────────────────────────
  const retry = await api(
    'POST',
    `/api/bulk-operations/${create.data.job.id}/retry-failed`,
  )
  if (retry.ok && retry.data?.job?.id) {
    createdJobIds.push(retry.data.job.id)
    ok(`retry-failed returned 201 with a new job (id=${retry.data.job.id})`)
  } else {
    bad('retry-failed', `status=${retry.status} body=${JSON.stringify(retry.data).slice(0,200)}`)
    throw new Error('cannot continue')
  }

  const newJob = retry.data.job
  if (newJob.actionType === 'PRICING_UPDATE') ok('Retry job: actionType preserved')
  else bad('Retry job actionType', `got ${newJob.actionType}`)

  if (newJob.totalItems === 1) ok('Retry job: scoped to 1 item (the failed one)')
  else bad('Retry job totalItems', `got ${newJob.totalItems}`)

  if (newJob.targetProductIds?.[0] === target.id) {
    ok('Retry job: targetProductIds includes the failed product')
  } else {
    bad('Retry job targetProductIds', `got ${JSON.stringify(newJob.targetProductIds)}`)
  }

  if (newJob.jobName === 'verify-retry-bogus (retry)') {
    ok('Retry job: jobName has " (retry)" suffix')
  } else {
    bad('Retry job jobName', `got ${newJob.jobName}`)
  }

  if (newJob.status === 'PENDING') {
    ok('Retry job: starts in PENDING (caller must POST /process to start it)')
  } else {
    bad('Retry job status', `got ${newJob.status}`)
  }

  // ── 4. retry-failed on a job with NO failed items returns 409 ─────
  // Create a fast-succeeding job, then attempt retry on it.
  const successJob = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-retry-clean',
    actionType: 'PRICING_UPDATE',
    targetProductIds: [target.id],
    actionPayload: { adjustmentType: 'PERCENT', value: 0 }, // no-op
  })
  if (successJob.ok) {
    createdJobIds.push(successJob.data.job.id)
    await api('POST', `/api/bulk-operations/${successJob.data.job.id}/process`)
    await pollJob(successJob.data.job.id)
    const noFailRetry = await api(
      'POST',
      `/api/bulk-operations/${successJob.data.job.id}/retry-failed`,
    )
    if (noFailRetry.status === 409) {
      ok('retry-failed returns 409 for a job with no failed items')
    } else {
      bad('retry-failed on clean job',
        `expected 409 got ${noFailRetry.status}`)
    }
  }

  // ── 5. retry-failed on a non-existent job returns 404 ─────────────
  const ghostRetry = await api(
    'POST',
    '/api/bulk-operations/cmnonexistent000/retry-failed',
  )
  if (ghostRetry.status === 404) {
    ok('retry-failed returns 404 for non-existent jobId')
  } else {
    bad('retry-failed on ghost job', `expected 404 got ${ghostRetry.status}`)
  }

} finally {
  console.log('\nCleaning up...')
  if (createdJobIds.length > 0) {
    const r = await client.query(
      `DELETE FROM "BulkActionJob" WHERE id = ANY($1::text[])`,
      [createdJobIds],
    )
    console.log(`  deleted ${r.rowCount} verification job(s) (+ items via cascade)`)
  }
  if (target) {
    const r2 = await client.query(
      `DELETE FROM "OutboundSyncQueue"
       WHERE "productId" = $1 AND "createdAt" > NOW() - INTERVAL '15 minutes'
         AND "syncStatus" = 'PENDING'`,
      [target.id],
    )
    if (r2.rowCount > 0) console.log(`  deleted ${r2.rowCount} pending OutboundSyncQueue row(s)`)
  }
  await client.end()
}

console.log(`\n${pass} pass / ${fail} fail`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
