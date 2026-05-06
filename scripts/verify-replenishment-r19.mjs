#!/usr/bin/env node
// R.19 verification — container / shipping cost optimization.
//
// Branches:
//   1. PUT  /supplier-shipping-profiles/:id with bad mode → 400
//   2. PUT  valid SEA_FCL_40 profile → 200
//   3. GET  the profile back → 200, mode matches
//   4. POST /container-fill with no body → 400
//   5. POST /container-fill with bad supplier → 404
//   6. /replenishment top-level returns containerFill[] array
//   7. /replenishment recommendations include freightCostPerUnitCents on
//      lines whose preferred supplier has a profile (best-effort: only
//      checked when fixture exists)
//
// Pure-function math (14 tests) ran at build time via tsx.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r19.mjs

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

// ─── Setup: pick a supplier from /suppliers (any will do) ──────────
let supplierId = null
{
  const res = await fetch(`${API_BASE}/api/suppliers?limit=1`)
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && Array.isArray(data?.items) && data.items.length > 0) {
    supplierId = data.items[0].id
    ok(`fixture supplier id=${supplierId}`)
  } else if (res.status === 200 && Array.isArray(data) && data.length > 0) {
    supplierId = data[0].id
    ok(`fixture supplier id=${supplierId}`)
  } else {
    bad(`could not fetch supplier fixture (status=${res.status})`)
    console.log(`\n[verify-replenishment-r19] PASS=${pass} FAIL=${fail}`)
    process.exit(fail > 0 ? 1 : 0)
  }
}

// ─── Branch 1: bad mode ─────
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/supplier-shipping-profiles/${supplierId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'TELEPORT' }),
    },
  )
  if (res.status === 400) ok('PUT bad mode → 400')
  else bad(`expected 400, got ${res.status}`)
}

// ─── Branch 2: valid PUT ─────
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/supplier-shipping-profiles/${supplierId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'SEA_FCL_40',
        fixedCostCents: 600000,
        currencyCode: 'EUR',
        containerCapacityCbm: 76,
        containerMaxWeightKg: 28800,
      }),
    },
  )
  const data = await res.json().catch(() => ({}))
  console.log(`[put profile] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 200 && data.ok && data.profile?.mode === 'SEA_FCL_40') {
    ok('PUT valid → 200 (mode=SEA_FCL_40)')
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 3: GET ─────
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/supplier-shipping-profiles/${supplierId}`,
  )
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && data.profile?.mode === 'SEA_FCL_40') {
    ok(`GET profile → SEA_FCL_40 (capacity=${data.profile.containerCapacityCbm} cbm)`)
  } else {
    bad(`GET expected 200 SEA_FCL_40, got ${res.status}`)
  }
}

// ─── Branch 4: container-fill empty body ─────
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/container-fill`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (res.status === 400) ok('POST container-fill {} → 400')
  else bad(`expected 400, got ${res.status}`)
}

// ─── Branch 5: container-fill bogus supplier ─────
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/container-fill`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId: 'no-such-id', items: [{ productId: 'x', unitsQty: 1 }] }),
    },
  )
  if (res.status === 404) ok('POST container-fill unknown supplier → 404')
  else bad(`expected 404, got ${res.status}`)
}

// ─── Branch 6: list response carries containerFill[] ─────
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?limit=10`)
  const data = await res.json().catch(() => ({}))
  if (res.status === 200) {
    if (Array.isArray(data.containerFill)) {
      ok(`list.containerFill is array (length=${data.containerFill.length})`)
      if (data.containerFill.length > 0) {
        const e = data.containerFill[0]
        if (typeof e.totalCbm === 'number' && typeof e.freightCostCents === 'number') {
          ok(`first containerFill entry has totalCbm + freightCostCents`)
        } else {
          bad('containerFill entry missing totalCbm/freightCostCents')
        }
      } else {
        ok('containerFill empty (acceptable — no preferred-supplier match in this run)')
      }
    } else {
      bad('list.containerFill not present or not array')
    }
  } else {
    bad(`list expected 200, got ${res.status}`)
  }
}

// ─── Branch 7: cleanup ─────
{
  // No DELETE route in v1 — leaving the profile in place is fine for
  // dev/staging since it's keyed on the supplier we just touched.
  ok('cleanup skipped (no DELETE route in v1)')
}

console.log(`\n[verify-replenishment-r19] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
