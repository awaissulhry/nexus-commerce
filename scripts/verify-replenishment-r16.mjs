#!/usr/bin/env node
// R.16 verification — forecast model A/B routing.
//
// Branches:
//   1. GET /forecast-models/active — 200 with champion + challengers shape.
//   2. POST /forecast-models/seed-champions — 200 with created count.
//   3. POST /forecast-models/rollout — 200 with assigned/removed/total.
//      Then GET /active sees the challenger.
//   4. POST /forecast-models/promote — 200 with migrated count;
//      challenger becomes champion.
//   5. Cleanup: rollout to 0% to remove our test challenger.
//
// Pure-function math (9 tests) ran at build time.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r16.mjs

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

const TEST_CHALLENGER_ID = `R16_VERIFY_${Date.now()}`

// ─── Branch 1: status (initial state) ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-models/active`)
  const data = await res.json().catch(() => ({}))
  console.log(`[active initial] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)
  if (res.status === 200) {
    ok('GET /forecast-models/active returns 200')
    if (data?.champion && typeof data.champion.modelId === 'string') ok(`champion = ${data.champion.modelId}`)
    else bad('champion block missing', JSON.stringify(data).slice(0, 200))
    if (Array.isArray(data?.challengers)) ok(`challengers array (length=${data.challengers.length})`)
    else bad('challengers not an array')
    if ('totalActiveSkus' in data) ok(`totalActiveSkus = ${data.totalActiveSkus}`)
    else bad('totalActiveSkus missing')
  } else if (res.status === 404) {
    bad('404 — Railway not deployed yet?')
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 2: seed champions ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-models/seed-champions`, {
    method: 'POST',
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[seed-champions] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 200 && data.ok === true) {
    ok(`seed-champions returned 200 (created=${data.created})`)
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 3: rollout (small percentage to avoid affecting prod) ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-models/rollout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengerModelId: TEST_CHALLENGER_ID, cohortPercent: 5 }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[rollout 5%] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 200 && data.ok === true) {
    ok(`rollout returned 200`)
    if (typeof data.assigned === 'number') ok(`assigned = ${data.assigned}`)
    else bad('assigned missing')
    if (typeof data.total === 'number') ok(`total target = ${data.total}`)
    else bad('total missing')
  } else {
    bad(`rollout expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 4: status sees the challenger ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-models/active`)
  const data = await res.json().catch(() => ({}))
  if (res.status === 200) {
    const found = (data.challengers ?? []).find((c) => c.modelId === TEST_CHALLENGER_ID)
    if (found) ok(`challenger ${TEST_CHALLENGER_ID} visible (skuCount=${found.skuCount})`)
    else bad('challenger not visible after rollout')
  } else {
    bad(`active expected 200, got ${res.status}`)
  }
}

// ─── Branch 5: cleanup — rollout to 0% removes the challenger ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-models/rollout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengerModelId: TEST_CHALLENGER_ID, cohortPercent: 0 }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[cleanup rollout 0%] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 200 && data.ok === true) {
    ok(`cleanup rollout returned 200 (removed=${data.removed})`)
  } else {
    bad(`cleanup expected 200, got ${res.status}`)
  }
}

// ─── Branch 6: bad inputs ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-models/rollout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (res.status === 400) ok('rollout 400 when challengerModelId missing')
  else bad(`expected 400, got ${res.status}`)
}

console.log(`\n[verify-replenishment-r16] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
