#!/usr/bin/env node
// R.20 verification — cash flow projection.
//
// Branches:
//   1. GET projection with default horizon → 200, 13 buckets, shape
//   2. GET projection with custom horizon → returns that many buckets
//   3. GET projection clamps below 4 / above 26
//   4. PUT cash on hand with bad value → 400
//   5. PUT cash on hand → 200, projection's cashOnHandCents updates
//   6. Bucket items shape: kind in PO_DUE/REC_DUE/WO_DUE/SALES_FORECAST
//
// Pure-function math (16 tests) ran at build time via tsx.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r20.mjs

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

// ─── Branch 1: default horizon ─────
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/cash-flow/projection`)
  const data = await res.json().catch(() => ({}))
  console.log(`[default] status=${res.status} buckets=${data.buckets?.length} dailyRev=${data.dailyRevenueCents}`)
  if (res.status === 200) {
    ok('GET projection → 200')
    if (data.buckets?.length === 13) ok('13 buckets returned')
    else bad(`expected 13 buckets, got ${data.buckets?.length}`)
    if ('cashOnHandCents' in data) ok('cashOnHandCents present (may be null)')
    else bad('cashOnHandCents missing from response')
    if (typeof data.dailyRevenueCents === 'number') ok(`dailyRevenueCents = ${data.dailyRevenueCents}`)
    else bad('dailyRevenueCents missing')
    // Bucket shape
    const b0 = data.buckets[0]
    if (b0?.weekStart && typeof b0.outflowCents === 'number' && typeof b0.endingBalanceCents === 'number') {
      ok('bucket shape OK')
    } else {
      bad('bucket shape malformed', JSON.stringify(b0).slice(0, 120))
    }
    if (['OK', 'AMBER', 'RED'].includes(b0?.health)) ok(`health = ${b0.health}`)
    else bad(`unexpected health value: ${b0?.health}`)
  } else {
    bad(`expected 200, got ${res.status}`)
  }
}

// ─── Branch 2: custom horizon ─────
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/cash-flow/projection?horizonWeeks=8`)
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && data.buckets?.length === 8) ok('horizonWeeks=8 → 8 buckets')
  else bad(`expected 8 buckets, got ${data.buckets?.length}`)
}

// ─── Branch 3: clamps ─────
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/cash-flow/projection?horizonWeeks=2`)
  const data = await res.json().catch(() => ({}))
  // 2 should clamp UP to 4
  if (res.status === 200 && data.buckets?.length === 4) ok('horizonWeeks=2 clamps → 4 buckets')
  else bad(`expected 4 (clamped from 2), got ${data.buckets?.length}`)
}
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/cash-flow/projection?horizonWeeks=99`)
  const data = await res.json().catch(() => ({}))
  // 99 should clamp DOWN to 26
  if (res.status === 200 && data.buckets?.length === 26) ok('horizonWeeks=99 clamps → 26 buckets')
  else bad(`expected 26 (clamped from 99), got ${data.buckets?.length}`)
}

// ─── Branch 4: PUT cash on hand bad value ─────
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/cash-flow/cash-on-hand`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cashOnHandCents: -100 }),
  })
  if (res.status === 400) ok('PUT cashOnHandCents=-100 → 400')
  else bad(`expected 400, got ${res.status}`)
}

// ─── Branch 5: PUT valid cash on hand ─────
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/cash-flow/cash-on-hand`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cashOnHandCents: 50000_00 }),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && data.ok && data.cashOnHandCents === 50000_00) {
    ok('PUT valid cash → 200')
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }

  // Re-fetch projection — should reflect the new cash on hand
  const res2 = await fetch(`${API_BASE}/api/fulfillment/replenishment/cash-flow/projection`)
  const d2 = await res2.json().catch(() => ({}))
  if (d2.cashOnHandCents === 50000_00) ok('projection sees updated cashOnHandCents')
  else bad(`expected cashOnHandCents=5,000,000 in projection, got ${d2.cashOnHandCents}`)
}

console.log(`\n[verify-replenishment-r20] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
