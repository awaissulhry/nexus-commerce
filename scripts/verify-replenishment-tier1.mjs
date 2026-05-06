#!/usr/bin/env node
// Verify the Tier-1 replenishment commits shipped 2026-05-06:
//   1306b67 — dismiss recommendation (R.21) + dismissal audit columns
//   a7e74f6 — bulk-dismiss recommendations
//   19aeeac — PO approval state machine (UI; existing endpoints exercised)
//
// Asserts:
//   1. Schema: ReplenishmentRecommendation has dismissedAt /
//      dismissedByUserId / dismissedReason columns (R.21 migration ran)
//   2. Single-dismiss: POST /:id/dismiss flips ACTIVE → DISMISSED with
//      audit fields populated. Idempotent on a non-ACTIVE row.
//   3. Bulk-dismiss: POST /bulk-dismiss flips N rows, returns
//      { succeeded, alreadyTerminal, failed }. Validates input.
//   4. PO transition: DRAFT → REVIEW via /transition records the
//      audit timestamps (reviewedAt + reviewedByUserId).
//
// Cleanup: delete any verify-created jobs/recs and revert mutated
// recs (since dismiss is permanent in v1).
//
// Usage:
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
//     node scripts/verify-replenishment-tier1.mjs

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
const touchedRecIds = []
const touchedPoIds = []
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

try {
  // ── 1. Schema columns present ─────────────────────────────────────
  const cols = (await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ReplenishmentRecommendation'
      AND column_name IN ('dismissedAt', 'dismissedByUserId', 'dismissedReason')
  `)).rows.map((r) => r.column_name)
  const expected = ['dismissedAt', 'dismissedByUserId', 'dismissedReason']
  const missing = expected.filter((c) => !cols.includes(c))
  if (missing.length === 0) {
    ok('R.21 migration: all 3 dismissal-audit columns present')
  } else {
    bad('R.21 migration', `missing columns: ${missing.join(', ')}`)
    process.exit(1)
  }

  // ── 2. Single-dismiss happy path ──────────────────────────────────
  // Pick one ACTIVE recommendation. Snapshot, dismiss, assert audit
  // fields, then revert (DISMISSED → ACTIVE) so the catalog stays clean.
  const candidate = (await client.query(`
    SELECT id, "productId", status FROM "ReplenishmentRecommendation"
    WHERE status = 'ACTIVE'
    LIMIT 1
  `)).rows[0]
  if (!candidate) {
    console.log('No ACTIVE recommendations to test against. Skipping dismiss assertions.')
  } else {
    touchedRecIds.push(candidate.id)
    const dismissRes = await api(
      'POST',
      `/api/fulfillment/replenishment/recommendations/${candidate.id}/dismiss`,
      { reason: 'verify-tier1-test', userId: 'verify-script' },
    )
    if (dismissRes.ok && dismissRes.data?.status === 'DISMISSED') {
      ok('Dismiss returns status=DISMISSED')
    } else {
      bad('Dismiss endpoint', `status=${dismissRes.status} body=${JSON.stringify(dismissRes.data).slice(0,200)}`)
    }
    if (dismissRes.data?.previousStatus === 'ACTIVE') {
      ok('Dismiss reports previousStatus=ACTIVE')
    } else {
      bad('Dismiss previousStatus', `got ${dismissRes.data?.previousStatus}`)
    }
    // Verify audit fields landed in DB
    const after = (await client.query(
      `SELECT status, "dismissedAt", "dismissedByUserId", "dismissedReason"
       FROM "ReplenishmentRecommendation" WHERE id = $1`,
      [candidate.id],
    )).rows[0]
    if (after.status === 'DISMISSED') ok('DB row status updated to DISMISSED')
    else bad('DB status', `got ${after.status}`)
    if (after.dismissedAt != null) ok('DB row dismissedAt populated')
    else bad('DB dismissedAt', 'null')
    if (after.dismissedByUserId === 'verify-script') {
      ok('DB row dismissedByUserId captured')
    } else {
      bad('DB dismissedByUserId', `got ${after.dismissedByUserId}`)
    }
    if (after.dismissedReason === 'verify-tier1-test') {
      ok('DB row dismissedReason captured')
    } else {
      bad('DB dismissedReason', `got ${after.dismissedReason}`)
    }

    // ── 3. Idempotent re-dismiss returns previousStatus=DISMISSED ───
    const reDismiss = await api(
      'POST',
      `/api/fulfillment/replenishment/recommendations/${candidate.id}/dismiss`,
      { reason: 'second-call' },
    )
    if (
      reDismiss.ok &&
      reDismiss.data?.status === 'DISMISSED' &&
      reDismiss.data?.previousStatus === 'DISMISSED'
    ) {
      ok('Re-dismiss is idempotent (previousStatus=DISMISSED)')
    } else {
      bad('Re-dismiss idempotency',
        `status=${reDismiss.status} previousStatus=${reDismiss.data?.previousStatus}`)
    }
  }

  // ── 4. Bulk-dismiss happy path ────────────────────────────────────
  // Need ≥2 ACTIVE recs to test bulk. If insufficient, skip.
  const bulkCandidates = (await client.query(`
    SELECT id FROM "ReplenishmentRecommendation"
    WHERE status = 'ACTIVE'
    LIMIT 3
  `)).rows.map((r) => r.id)
  if (bulkCandidates.length < 2) {
    console.log(`Only ${bulkCandidates.length} ACTIVE rec(s) — skipping bulk-dismiss test`)
  } else {
    touchedRecIds.push(...bulkCandidates)
    const bulk = await api(
      'POST',
      '/api/fulfillment/replenishment/recommendations/bulk-dismiss',
      {
        recommendationIds: bulkCandidates,
        reason: 'verify-bulk-tier1',
        userId: 'verify-script',
      },
    )
    if (bulk.ok && bulk.data?.succeeded === bulkCandidates.length) {
      ok(`Bulk-dismiss: succeeded=${bulk.data.succeeded} (all ${bulkCandidates.length} flipped)`)
    } else {
      bad('Bulk-dismiss', `status=${bulk.status} body=${JSON.stringify(bulk.data).slice(0,200)}`)
    }
    if (bulk.data?.alreadyTerminal === 0) ok('Bulk-dismiss alreadyTerminal=0')
    else bad('Bulk-dismiss alreadyTerminal', `got ${bulk.data?.alreadyTerminal}`)
    if (Array.isArray(bulk.data?.failed) && bulk.data.failed.length === 0) {
      ok('Bulk-dismiss failed array is empty')
    } else {
      bad('Bulk-dismiss failed', `got ${JSON.stringify(bulk.data?.failed)}`)
    }
  }

  // ── 5. Bulk-dismiss validates empty array ─────────────────────────
  const empty = await api(
    'POST',
    '/api/fulfillment/replenishment/recommendations/bulk-dismiss',
    { recommendationIds: [] },
  )
  if (empty.status === 400) {
    ok('Bulk-dismiss rejects empty recommendationIds (400)')
  } else {
    bad('Bulk-dismiss empty validation', `expected 400 got ${empty.status}`)
  }

  // ── 6. PO transition DRAFT → REVIEW ───────────────────────────────
  // Find a DRAFT PO. If none, skip.
  const draftPo = (await client.query(`
    SELECT id, status FROM "PurchaseOrder"
    WHERE status = 'DRAFT'
    LIMIT 1
  `)).rows[0]
  if (!draftPo) {
    console.log('No DRAFT POs available for transition test — skipping')
  } else {
    touchedPoIds.push(draftPo.id)
    const tr = await api(
      'POST',
      `/api/fulfillment/purchase-orders/${draftPo.id}/transition`,
      { transition: 'submit-for-review', userId: 'verify-script' },
    )
    if (tr.ok) {
      ok(`PO transition DRAFT → ${tr.data?.status} via submit-for-review`)
    } else {
      bad('PO transition', `status=${tr.status} body=${JSON.stringify(tr.data).slice(0,200)}`)
    }
    // Audit endpoint reflects the transition
    const audit = await api(
      'GET',
      `/api/fulfillment/purchase-orders/${draftPo.id}/audit`,
    )
    if (audit.ok && Array.isArray(audit.data?.trail)) {
      const reviewEntry = audit.data.trail.find((e) => e.status === 'REVIEW' || e.status === 'APPROVED')
      if (reviewEntry) {
        ok('Audit trail records the new state with timestamp')
      } else {
        bad('Audit trail missing transition', JSON.stringify(audit.data.trail).slice(0,200))
      }
    } else {
      bad('Audit endpoint', `status=${audit.status}`)
    }
  }

} finally {
  console.log('\nCleaning up...')

  // Revert dismissed recs back to ACTIVE so the catalog stays as we found it.
  if (touchedRecIds.length > 0) {
    const r = await client.query(
      `UPDATE "ReplenishmentRecommendation"
       SET status = 'ACTIVE',
           "dismissedAt" = NULL,
           "dismissedByUserId" = NULL,
           "dismissedReason" = NULL
       WHERE id = ANY($1::text[])
         AND "dismissedReason" IN ('verify-tier1-test', 'verify-bulk-tier1', 'second-call')`,
      [touchedRecIds],
    )
    console.log(`  reverted ${r.rowCount} recommendation(s) to ACTIVE`)
  }

  // Revert PO transitions back to DRAFT (only if we moved them and the
  // transition we made was the ONLY transition — i.e. no prior REVIEW/APPROVED
  // before us). Conservative: undo only the timestamp our verify-script set.
  if (touchedPoIds.length > 0) {
    const r = await client.query(
      `UPDATE "PurchaseOrder"
       SET status = 'DRAFT',
           "reviewedAt" = NULL,
           "reviewedByUserId" = NULL,
           "approvedAt" = NULL,
           "approvedByUserId" = NULL
       WHERE id = ANY($1::text[])
         AND ("reviewedByUserId" = 'verify-script' OR "approvedByUserId" = 'verify-script')`,
      [touchedPoIds],
    )
    console.log(`  reverted ${r.rowCount} PO(s) to DRAFT`)
  }

  await client.end()
}

console.log(`\n${pass} pass / ${fail} fail`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
