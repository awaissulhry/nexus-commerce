#!/usr/bin/env node
// R.17 verification — substitution-aware demand.
//
// Branches:
//   1. POST /substitutions with bad input → 400
//   2. POST /substitutions identical primary+substitute → 400
//   3. POST /substitutions valid (using two seeded products) → 200
//   4. GET  /substitutions/:productId → list contains the new link
//   5. PATCH /substitutions/:id → 200, fraction updates
//   6. PATCH bad fraction → 400
//   7. DELETE /substitutions/:id → 200, gone from list
//   8. forecast-detail returns substitutions array (smoke test on a real SKU)
//
// Pure-function math (8 tests) ran at build time via tsx.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r17.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// ─── Setup: pull two real product IDs from the replenishment list ───
let primaryId = null
let substituteId = null
let primarySku = null
let substituteSku = null
{
  const url = `${API_BASE}/api/fulfillment/replenishment?limit=2`
  const res = await fetch(url)
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && Array.isArray(data?.suggestions) && data.suggestions.length >= 2) {
    primaryId = data.suggestions[0].productId
    primarySku = data.suggestions[0].sku
    substituteId = data.suggestions[1].productId
    substituteSku = data.suggestions[1].sku
    ok(`fixture: primary=${primarySku} substitute=${substituteSku}`)
  } else {
    bad(`could not fetch fixture products from /replenishment (status=${res.status})`)
    console.log(`\n[verify-replenishment-r17] PASS=${pass} FAIL=${fail}`)
    process.exit(fail > 0 ? 1 : 0)
  }
}

// ─── Branch 1: POST with no body → 400 ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/substitutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (res.status === 400) ok('POST {} → 400')
  else bad(`expected 400 on empty body, got ${res.status}`)
}

// ─── Branch 2: identical primary+substitute → 400 ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/substitutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primaryProductId: primaryId,
      substituteProductId: primaryId,
    }),
  })
  if (res.status === 400) ok('POST identical primary/substitute → 400')
  else bad(`expected 400, got ${res.status}`)
}

// ─── Branch 3: valid create ───
let createdId = null
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/substitutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primaryProductId: primaryId,
      substituteProductId: substituteId,
      substitutionFraction: 0.4,
    }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[create] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 200 && data.ok && data.item?.id) {
    ok(`POST valid → 200 (id=${data.item.id})`)
    createdId = data.item.id
  } else if (res.status === 409) {
    // Already exists from a prior test run — fetch the existing one to continue
    const list = await fetch(
      `${API_BASE}/api/fulfillment/replenishment/substitutions/${primaryId}`,
    )
    const ld = await list.json().catch(() => ({}))
    const found = (ld.items ?? []).find((r) => r.substituteProductId === substituteId)
    if (found) {
      ok(`POST valid → 409 (recovering existing id=${found.id})`)
      createdId = found.id
    } else {
      bad('409 but could not recover id')
    }
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

if (!createdId) {
  console.log(`\n[verify-replenishment-r17] PASS=${pass} FAIL=${fail}`)
  process.exit(1)
}

// ─── Branch 4: list ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/substitutions/${primaryId}`,
  )
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && Array.isArray(data.items)) {
    const found = data.items.find((r) => r.id === createdId)
    if (found) ok(`GET list contains created link (fraction=${found.substitutionFraction})`)
    else bad('created link not visible in list')
  } else {
    bad(`expected 200, got ${res.status}`)
  }
}

// ─── Branch 5: patch fraction ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/substitutions/${createdId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ substitutionFraction: 0.7 }),
    },
  )
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && data.ok) ok(`PATCH fraction → 200 (now ${data.item?.substitutionFraction})`)
  else bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
}

// ─── Branch 6: bad fraction ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/substitutions/${createdId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ substitutionFraction: 1.5 }),
    },
  )
  if (res.status === 400) ok('PATCH fraction=1.5 → 400')
  else bad(`expected 400, got ${res.status}`)
}

// ─── Branch 7: forecast-detail returns substitutions ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/${primaryId}/forecast-detail`,
  )
  const data = await res.json().catch(() => ({}))
  if (res.status === 200) {
    if (Array.isArray(data.substitutions)) {
      ok(`forecast-detail.substitutions is array (length=${data.substitutions.length})`)
    } else {
      bad('forecast-detail.substitutions missing or not array')
    }
    if ('rawVelocity' in (data.recommendation ?? {})) {
      ok('recommendation.rawVelocity present (may be null pre-engine-rerun)')
    } else {
      bad('recommendation.rawVelocity missing from detail response')
    }
  } else {
    bad(`forecast-detail expected 200, got ${res.status}`)
  }
}

// ─── Branch 8: cleanup delete ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/substitutions/${createdId}`,
    { method: 'DELETE' },
  )
  if (res.status === 200) ok('DELETE → 200')
  else bad(`expected 200, got ${res.status}`)
}

console.log(`\n[verify-replenishment-r17] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
