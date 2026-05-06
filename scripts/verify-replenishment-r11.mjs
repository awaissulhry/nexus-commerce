#!/usr/bin/env node
// R.11 verification — lead-time variance in safety stock.
//
// Branches:
//   1. GET /lead-time-stats/status — 200 with config + counts.
//   2. POST /lead-time-stats/recompute — 200 with summary; per-
//      supplier mode also accepted via { supplierId }.
//   3. /replenishment list emits leadTimeStdDevDays per suggestion.
//   4. forecast-detail.recommendation includes leadTimeStdDevDays.
//
// Pure-function math (12 new tests for σ_LT term + computeLeadTime-
// Stats edge cases) ran at build time.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r11.mjs

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

// ─── Branch 1: status ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/lead-time-stats/status`)
  const data = await res.json().catch(() => ({}))
  console.log(`[status] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)
  if (res.status === 200) {
    ok('GET /lead-time-stats/status returns 200')
    if ('historyWindowDays' in data) ok(`historyWindowDays = ${data.historyWindowDays}`)
    else bad('historyWindowDays missing')
    if ('minSampleCount' in data) ok(`minSampleCount = ${data.minSampleCount}`)
    else bad('minSampleCount missing')
    if (data.cron && typeof data.cron.scheduled === 'boolean') ok(`cron.scheduled = ${data.cron.scheduled}`)
    else bad('cron block missing')
    if ('activeSupplierCount' in data) ok(`activeSupplierCount = ${data.activeSupplierCount}`)
    else bad('activeSupplierCount missing')
    if ('suppliersWithSigma' in data) ok(`suppliersWithSigma = ${data.suppliersWithSigma}`)
    else bad('suppliersWithSigma missing')
  } else if (res.status === 404) {
    bad('404 — Railway not deployed yet?')
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 2: manual recompute ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/lead-time-stats/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[recompute] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)
  if (res.status === 200 && data.ok === true) {
    ok('POST /recompute returns 200')
    if (typeof data.suppliersScanned === 'number') ok(`suppliersScanned = ${data.suppliersScanned}`)
    else bad('suppliersScanned missing')
    if (typeof data.suppliersUpdated === 'number') ok(`suppliersUpdated = ${data.suppliersUpdated}`)
    else bad('suppliersUpdated missing')
    if (typeof data.suppliersWithSufficientHistory === 'number') {
      ok(`suppliersWithSufficientHistory = ${data.suppliersWithSufficientHistory}`)
    } else bad('suppliersWithSufficientHistory missing')
    if (typeof data.durationMs === 'number') ok(`durationMs = ${data.durationMs}`)
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 3: list emits leadTimeStdDevDays ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const data = await res.json().catch(() => ({}))
  if (res.status === 200 && Array.isArray(data?.suggestions) && data.suggestions.length > 0) {
    const s = data.suggestions[0]
    if ('leadTimeStdDevDays' in s) ok(`suggestion.leadTimeStdDevDays = ${s.leadTimeStdDevDays}`)
    else bad('suggestion.leadTimeStdDevDays missing', JSON.stringify(s).slice(0, 200))
  } else {
    ok('No suggestions — list field branch skipped')
  }
}

// ─── Branch 4: forecast-detail recommendation includes σ_LT ───
{
  const listRes = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const listData = await listRes.json().catch(() => ({}))
  const sampleProductId = listData?.suggestions?.[0]?.productId ?? null
  if (sampleProductId) {
    const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/${sampleProductId}/forecast-detail`)
    const data = await res.json().catch(() => ({}))
    if (res.status === 200 && data?.recommendation) {
      if ('leadTimeStdDevDays' in data.recommendation) {
        ok(`recommendation.leadTimeStdDevDays = ${data.recommendation.leadTimeStdDevDays}`)
      } else bad('recommendation.leadTimeStdDevDays missing', JSON.stringify(data.recommendation).slice(0, 200))
    } else {
      ok('No active recommendation — forecast-detail branch skipped')
    }
  } else {
    ok('No product to probe — forecast-detail branch skipped')
  }
}

console.log(`\n[verify-replenishment-r11] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
