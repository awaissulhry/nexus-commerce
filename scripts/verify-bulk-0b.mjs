#!/usr/bin/env node
// Bulk-operations 0b verification.
//
// Asserts the validator gap fix: POST /api/bulk-operations with
// actionType='MARKETPLACE_OVERRIDE_UPDATE' must no longer be rejected
// by Zod (was hard-blocked at routes/validation.ts before this commit).
//
// Cross-checks:
//   - 5 previously-supported actionType values still validate
//   - Bogus actionType still returns 400 with an enum error
//
// Cleanup: any jobs created during verification are DELETEd directly
// from the DB by id so we don't pollute job history. The jobs are
// never /process'd, so no real product mutations occur.
//
// Usage:
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
//     node scripts/verify-bulk-0b.mjs
//
// Note: the second half of 0b — the bulk-job.completed BroadcastChannel
// emission from BulkOperationModal — is browser-only and verified by
// hand: open /products in tab A, run a bulk op in tab B, confirm tab A
// refetches. No automatable surface from Node.

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

async function postCreate(body) {
  const res = await fetch(`${API_BASE}/api/bulk-operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (data && data.job && data.job.id) createdJobIds.push(data.job.id)
  return { status: res.status, data }
}

function isValidatorRejection(data) {
  // Zod errors come back as { success: false, error: 'Invalid request body', details: [...] }
  if (!data || typeof data !== 'object') return false
  if (data.error !== 'Invalid request body') return false
  return Array.isArray(data.details)
}

const baseBody = {
  jobName: 'verify-0b-validator',
  filters: { brand: '__verify_no_match__' },
  actionPayload: { sentinel: true },
}

try {
  // 1. The fix: MARKETPLACE_OVERRIDE_UPDATE no longer hits the validator.
  {
    const { status, data } = await postCreate({
      ...baseBody,
      actionType: 'MARKETPLACE_OVERRIDE_UPDATE',
      channel: 'AMAZON',
      actionPayload: { priceOverride: 99.99 },
    })
    if (status === 400 && isValidatorRejection(data)) {
      bad('MARKETPLACE_OVERRIDE_UPDATE accepted by Zod validator',
        `still rejected — details: ${JSON.stringify(data.details)}`)
    } else {
      ok(`MARKETPLACE_OVERRIDE_UPDATE accepted by Zod validator (status=${status})`)
    }
  }

  // 2. Regression: previously-supported types still validate.
  for (const t of [
    'PRICING_UPDATE',
    'INVENTORY_UPDATE',
    'STATUS_UPDATE',
    'ATTRIBUTE_UPDATE',
    'LISTING_SYNC',
  ]) {
    const { status, data } = await postCreate({
      ...baseBody,
      actionType: t,
    })
    if (status === 400 && isValidatorRejection(data)) {
      const detail = data.details.find(d => d.path === 'actionType')
      if (detail) {
        bad(`${t} regression — Zod no longer accepts`, JSON.stringify(detail))
        continue
      }
    }
    ok(`${t} validates (status=${status})`)
  }

  // 3. Regression: bogus actionType still rejected.
  {
    const { status, data } = await postCreate({
      ...baseBody,
      actionType: 'NOT_A_REAL_TYPE',
    })
    const rejected = status === 400 && isValidatorRejection(data) &&
      data.details.some(d => d.path === 'actionType')
    if (rejected) {
      ok('Bogus actionType still rejected by Zod')
    } else {
      bad('Bogus actionType regression', `expected 400 + actionType detail, got status=${status} data=${JSON.stringify(data).slice(0, 200)}`)
    }
  }
} finally {
  // Cleanup: delete any jobs we created.
  if (createdJobIds.length > 0) {
    const result = await client.query(
      `DELETE FROM "BulkActionJob" WHERE id = ANY($1::text[])`,
      [createdJobIds],
    )
    console.log(`\nCleaned up ${result.rowCount} verification job(s).`)
  }
  await client.end()
}

console.log(`\n${pass} pass / ${fail} fail`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
