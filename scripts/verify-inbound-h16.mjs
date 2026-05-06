#!/usr/bin/env node
// H.16 verification — compliance fields + recall lookup.
//
//   PATCH /api/fulfillment/inbound/:id/compliance
//     - 404 for unknown shipment id.
//   GET /api/fulfillment/inbound/lots/:lotNumber
//     - 200 with { lotNumber, count, items[] } shape, even when
//       no lots have been recorded yet (returns count=0).
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h16.mjs

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

// ─── Branch 1: PATCH unknown shipment → 404 ───
{
  const SYNTH = `inb_synth_${Date.now()}`
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/${SYNTH}/compliance`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: 'noop', lotNumber: 'TEST' }] }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[PATCH unknown] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 404) ok('PATCH /:id/compliance returns 404 for unknown shipment')
  else if (res.status === 405) bad('405: route may not be wired')
  else bad(`expected 404, got ${res.status}`, JSON.stringify(data).slice(0, 200))
}

// ─── Branch 2: lot lookup with synthetic lot number ───
{
  const SYNTH_LOT = `LOT_VERIFY_${Date.now()}`
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/lots/${encodeURIComponent(SYNTH_LOT)}`)
  const data = await res.json().catch(() => ({}))
  console.log(`[lot lookup synthetic] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 200) {
    ok('GET /lots/:lotNumber returns 200')
    if (data?.lotNumber === SYNTH_LOT) ok('lotNumber echoed')
    else bad('lotNumber not echoed', JSON.stringify(data))
    if (typeof data?.count === 'number') ok(`count is a number (${data.count})`)
    else bad('count missing', JSON.stringify(data))
    if (Array.isArray(data?.items)) ok('items is an array')
    else bad('items not an array', JSON.stringify(data))
    if (data?.count === 0) ok('synthetic lot returns 0 items (expected)')
  } else if (res.status === 404) {
    bad('404: route not deployed yet?', JSON.stringify(data).slice(0, 200))
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 3: lot lookup with empty path → 400 ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/lots/${encodeURIComponent('   ')}`)
  const data = await res.json().catch(() => ({}))
  console.log(`[lot lookup empty] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 400) ok('empty lot number returns 400')
  else if (res.status === 200 && data?.count === 0) ok('empty lot number returns 200 with 0 results (acceptable)')
  else bad(`unexpected status ${res.status}`, JSON.stringify(data).slice(0, 200))
}

console.log(`\n[verify-inbound-h16] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
