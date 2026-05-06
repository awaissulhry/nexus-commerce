#!/usr/bin/env node
// R.9 verification — multi-supplier comparison.
//
// Branches:
//   1. GET supplier-comparison for unknown product → 200 with empty candidates
//   2. GET for a real product → 200 with ranked candidates[]
//   3. POST set preferred-supplier with no body → 400
//   4. POST set preferred-supplier with bogus supplier → 400 (no SupplierProduct row)
//   5. Score shape: composite/cost/speed/flex/reliability all in [0,1]
//
// Pure-function math (12 tests) ran at build time via tsx.

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

// ─── Pull a real productId from the replenishment list ───
let productId = null
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?limit=1`)
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && data.suggestions?.[0]?.productId) {
    productId = data.suggestions[0].productId
    ok(`fixture productId=${productId}`)
  } else {
    bad(`could not fetch fixture (status=${res.status})`)
    console.log(`\n[verify-replenishment-r9] PASS=${pass} FAIL=${fail}`)
    process.exit(fail > 0 ? 1 : 0)
  }
}

// ─── Branch 1: unknown product ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/products/no-such-product-r9/supplier-comparison`,
  )
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && Array.isArray(data.candidates) && data.candidates.length === 0) {
    ok('GET unknown product → 200 with []')
  } else {
    bad(`expected 200 + empty, got ${res.status}`)
  }
}

// ─── Branch 2: real product ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/products/${productId}/supplier-comparison`,
  )
  const data = await res.json().catch(() => ({}))
  console.log(`[real product] status=${res.status} candidates=${data.candidates?.length}`)
  if (res.status === 200) {
    ok('GET real product → 200')
    if (Array.isArray(data.candidates)) ok(`candidates array (length=${data.candidates.length})`)
    else bad('candidates not an array')
    if (data.urgency) ok(`urgency echoed = ${data.urgency}`)
    else bad('urgency missing')
    if (data.candidates?.[0]) {
      const c = data.candidates[0]
      const inRange = (v) => typeof v === 'number' && v >= 0 && v <= 1
      if (inRange(c.compositeScore) && inRange(c.costScore) && inRange(c.speedScore) &&
          inRange(c.flexScore) && inRange(c.reliabilityScore)) {
        ok(`first candidate scores all in [0,1] (composite=${c.compositeScore})`)
      } else {
        bad(`scores out of range: ${JSON.stringify({c: c.compositeScore, cost: c.costScore, speed: c.speedScore})}`)
      }
      if (c.rank === 1) ok('first candidate has rank=1')
      else bad(`first candidate rank=${c.rank}`)
    }
  } else {
    bad(`expected 200, got ${res.status}`)
  }
}

// ─── Branch 3: empty body POST → 400 ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/products/${productId}/preferred-supplier`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (res.status === 400) ok('POST set-preferred {} → 400')
  else bad(`expected 400, got ${res.status}`)
}

// ─── Branch 4: bogus supplier ───
{
  const res = await fetch(
    `${API_BASE}/api/fulfillment/replenishment/products/${productId}/preferred-supplier`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId: 'no-such-supplier-r9' }),
    },
  )
  if (res.status === 400) ok('POST set-preferred bogus supplier → 400')
  else bad(`expected 400, got ${res.status}`)
}

console.log(`\n[verify-replenishment-r9] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
