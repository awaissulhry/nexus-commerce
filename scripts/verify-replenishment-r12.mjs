#!/usr/bin/env node
// R.12 verification — stockout ledger.
//
// Branches:
//   1. GET /stockouts/summary — 200 with windowDays/openCount/etc.
//   2. GET /stockouts/events — 200 with items array.
//   3. POST /stockouts/sweep — 200 with { ok, opened, closed, ... }
//   4. GET /stockouts/status — cron snapshot.
//
// Pure-function math (12 tests for classifyMovement + computeLoss
// edge cases) ran at build time.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r12.mjs

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

// ─── Branch 1: summary ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/stockouts/summary?windowDays=30`)
  const data = await res.json().catch(() => ({}))
  console.log(`[summary] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)
  if (res.status === 200) {
    ok('GET /stockouts/summary returns 200')
    for (const k of ['windowDays', 'openCount', 'eventsInWindow', 'totalDurationDays', 'totalLostUnits', 'totalLostRevenueCents', 'totalLostMarginCents']) {
      if (k in data) ok(`summary.${k} present`)
      else bad(`summary.${k} missing`)
    }
  } else if (res.status === 404) {
    bad('404 — Railway not deployed yet?')
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 2: events ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/stockouts/events?status=all&limit=10`)
  const data = await res.json().catch(() => ({}))
  console.log(`[events] status=${res.status} count=${data?.count}`)
  if (res.status === 200) {
    ok('GET /stockouts/events returns 200')
    if (Array.isArray(data.items)) ok(`items array (length=${data.items.length})`)
    else bad('items not an array', JSON.stringify(data).slice(0, 200))
  } else {
    bad(`expected 200, got ${res.status}`)
  }
}

// ─── Branch 3: sweep ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/stockouts/sweep`, { method: 'POST' })
  const data = await res.json().catch(() => ({}))
  console.log(`[sweep] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)
  if (res.status === 200 && data.ok === true) {
    ok('POST /stockouts/sweep returns 200')
    for (const k of ['opened', 'closed', 'updatedRunning', 'durationMs']) {
      if (k in data) ok(`sweep.${k} = ${data[k]}`)
      else bad(`sweep.${k} missing`)
    }
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 4: status ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/stockouts/status`)
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && data?.cron) {
    ok(`GET /stockouts/status: cron.scheduled = ${data.cron.scheduled}`)
  } else {
    bad(`status expected 200 with cron block, got ${res.status}`)
  }
}

console.log(`\n[verify-replenishment-r12] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
