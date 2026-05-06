#!/usr/bin/env node
// R.1 verification — forecast accuracy infrastructure.
//
// Three endpoints:
//   GET  /api/fulfillment/replenishment/forecast-accuracy?sku=…
//   GET  /api/fulfillment/replenishment/forecast-accuracy/aggregate
//   POST /api/fulfillment/replenishment/forecast-accuracy/backfill
//
// We don't trigger the cron from here (lives on its 04:00 UTC
// schedule). Instead:
//   1. Aggregate endpoint should return 200 with a shape including
//      windowDays / overall / groups / trend. sampleCount may be 0
//      (no data yet, dashboards will be empty until backfill runs).
//   2. Per-SKU endpoint with a synthetic SKU should return 200 with
//      sampleCount=0 + null metrics — proves the pipe is wired.
//   3. Backfill endpoint should accept fromDay/toDay and return
//      counts. With no qualifying forecasts, evaluated=0 + skipped
//      reflects all-day count is fine.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r1.mjs

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

// ─── Branch 1: missing sku → 400 ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-accuracy`)
  const data = await res.json().catch(() => ({}))
  console.log(`[no-sku] status=${res.status} body=${JSON.stringify(data).slice(0, 150)}`)
  if (res.status === 400 && /sku/i.test(data?.error ?? '')) ok('400 when sku missing')
  else if (res.status === 404) bad('404 — route not deployed yet?', JSON.stringify(data).slice(0, 150))
  else bad(`expected 400, got ${res.status}`, JSON.stringify(data).slice(0, 200))
}

// ─── Branch 2: per-sku synthetic SKU returns shape with sampleCount=0 ───
{
  const SYNTH = `R1_VERIFY_${Date.now()}`
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-accuracy?sku=${encodeURIComponent(SYNTH)}&windowDays=30`)
  const data = await res.json().catch(() => ({}))
  console.log(`[per-sku synthetic] status=${res.status} sampleCount=${data?.sampleCount}`)
  if (res.status === 200) {
    ok('200 for synthetic SKU')
    if (data?.sku === SYNTH) ok('sku echoed')
    else bad('sku not echoed', JSON.stringify(data).slice(0, 200))
    if (data?.windowDays === 30) ok('windowDays = 30')
    else bad('windowDays mismatch', JSON.stringify(data).slice(0, 200))
    if (typeof data?.sampleCount === 'number') ok(`sampleCount is a number (${data.sampleCount})`)
    else bad('sampleCount missing')
    if (data?.sampleCount === 0) {
      if (data.mape === null && data.mae === null && data.bandCalibration === null) ok('null metrics on zero samples (expected)')
      else bad('expected null metrics with no samples', JSON.stringify({ mape: data.mape, mae: data.mae, bc: data.bandCalibration }))
    }
    if (Array.isArray(data?.series)) ok('series is an array')
    else bad('series missing')
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 3: aggregate returns valid shape ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-accuracy/aggregate?windowDays=30&groupBy=regime`)
  const data = await res.json().catch(() => ({}))
  console.log(`[aggregate] status=${res.status} sampleCount=${data?.overall?.sampleCount} groups=${data?.groups?.length}`)
  if (res.status === 200) {
    ok('200 for aggregate')
    if (data?.windowDays === 30) ok('windowDays = 30')
    else bad('windowDays missing')
    if (data?.overall && typeof data.overall.sampleCount === 'number') ok(`overall.sampleCount is a number (${data.overall.sampleCount})`)
    else bad('overall block missing')
    if (Array.isArray(data?.groups)) ok(`groups array (length=${data.groups.length})`)
    else bad('groups not an array')
    if (Array.isArray(data?.trend)) ok(`trend array (length=${data.trend.length})`)
    else bad('trend not an array')
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 4: backfill happy + bad-input branches ───
{
  // Bad input: missing fromDay/toDay
  const r1 = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-accuracy/backfill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  const d1 = await r1.json().catch(() => ({}))
  if (r1.status === 400) ok('backfill 400 when fromDay/toDay missing')
  else bad(`backfill expected 400, got ${r1.status}`, JSON.stringify(d1).slice(0, 150))

  // Happy: 7-day window. Even if no qualifying forecasts exist, the
  // endpoint should run and return counts.
  const today = new Date()
  const fromDay = new Date(today.getTime() - 7 * 86400_000).toISOString().slice(0, 10)
  const toDay = new Date(today.getTime() - 1 * 86400_000).toISOString().slice(0, 10)
  const r2 = await fetch(`${API_BASE}/api/fulfillment/replenishment/forecast-accuracy/backfill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDay, toDay }),
  })
  const d2 = await r2.json().catch(() => ({}))
  console.log(`[backfill 7d] status=${r2.status} body=${JSON.stringify(d2).slice(0, 200)}`)
  if (r2.status === 200 && d2?.ok === true) {
    ok('backfill 200 over 7-day window')
    if (typeof d2.days === 'number') ok(`backfill days=${d2.days}`)
    if (typeof d2.evaluated === 'number') ok(`backfill evaluated=${d2.evaluated}`)
    if (typeof d2.skippedNoForecast === 'number') ok(`backfill skipped=${d2.skippedNoForecast}`)
  } else {
    bad(`backfill expected 200, got ${r2.status}`, JSON.stringify(d2).slice(0, 200))
  }
}

console.log(`\n[verify-replenishment-r1] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
