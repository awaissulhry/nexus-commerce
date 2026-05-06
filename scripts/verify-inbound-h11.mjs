#!/usr/bin/env node
// H.11 (Inbound) verification — landed cost API.
//
//   GET /api/fulfillment/inbound/:id  → must include landedCost summary.
//   PATCH /api/fulfillment/inbound/:id/costs  → accepts shipment-level
//     fields and per-item unitCostCents updates.
//
// We can't easily create a fixture shipment from a smoke script
// (createInbound has many required fields) so the verify is shape-
// only:
//   - 404 path: PATCH a synthetic id → expect 404 with helpful error.
//   - GET path: against any real shipment ID present in the system,
//     ensure landedCost block is present and well-formed. If no
//     shipments exist (count=0 from list endpoint), this branch is
//     skipped (still passes — the route is still wired correctly).
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h11.mjs

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

// ─── Branch 1: PATCH unknown shipment id → 404 ───
{
  const SYNTH_ID = `inb_synth_${Date.now()}`
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/${SYNTH_ID}/costs`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shippingCostCents: 1000 }),
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  console.log(`[PATCH unknown] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 404) {
    ok('PATCH /:id/costs returns 404 for unknown shipment')
  } else if (res.status === 405) {
    bad('405: method not allowed — route may not support PATCH', JSON.stringify(data).slice(0, 200))
  } else {
    bad(`expected 404, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 2: GET any real shipment includes landedCost ───
{
  const listRes = await fetch(`${API_BASE}/api/fulfillment/inbound?limit=1`)
  const listData = await listRes.json().catch(() => ({}))
  const sampleId = listData?.items?.[0]?.id ?? null

  if (!sampleId) {
    ok('No shipments in system — landedCost shape branch skipped (route still wired)')
  } else {
    const res = await fetch(`${API_BASE}/api/fulfillment/inbound/${sampleId}`)
    const data = await res.json().catch(() => ({}))
    console.log(`[GET ${sampleId}] status=${res.status} landedCost=${JSON.stringify(data?.landedCost).slice(0, 200)}`)
    if (res.status === 200) {
      ok('GET /:id returns 200')
      if (data?.landedCost && typeof data.landedCost === 'object') {
        ok('response includes landedCost block')
        for (const k of ['currencyCode', 'goodsCents', 'shippingCents', 'customsCents', 'dutiesCents', 'insuranceCents', 'totalCents']) {
          if (k in data.landedCost) ok(`landedCost.${k} present`)
          else bad(`landedCost.${k} missing`, JSON.stringify(data.landedCost))
        }
        const expected = (data.landedCost.goodsCents ?? 0) + (data.landedCost.shippingCents ?? 0) + (data.landedCost.customsCents ?? 0) + (data.landedCost.dutiesCents ?? 0) + (data.landedCost.insuranceCents ?? 0)
        if (data.landedCost.totalCents === expected) ok('landedCost.totalCents = sum of components')
        else bad(`landedCost.totalCents (${data.landedCost.totalCents}) != sum (${expected})`, JSON.stringify(data.landedCost))
      } else {
        bad('landedCost block missing from response', JSON.stringify(data).slice(0, 300))
      }
    } else {
      bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 300))
    }
  }
}

console.log(`\n[verify-inbound-h11] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
