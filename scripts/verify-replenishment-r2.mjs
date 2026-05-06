#!/usr/bin/env node
// R.2 verification — multi-location ATP + per-channel cover.
//
//   GET /api/fulfillment/replenishment?window=30
//     - Each suggestion includes: byLocation[], totalAvailable,
//       stockSource, channelCover[].
//
//   GET /api/fulfillment/replenishment/:productId/forecast-detail
//     - atp.byLocation[], atp.totalAvailable, atp.stockSource,
//       channelCover[] all present.
//
// We don't seed fixture data — just probe shape against whatever's
// live on Railway. The double-counting check lives in the pure-
// function tests (atp-channel.service.test.ts) which run at build
// time.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r2.mjs

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

// ─── Branch 1: replenishment list emits new fields ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const data = await res.json().catch(() => ({}))
  console.log(`[list] status=${res.status} suggestions=${data?.suggestions?.length}`)
  if (res.status !== 200) {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  } else if (!Array.isArray(data?.suggestions) || data.suggestions.length === 0) {
    ok('No suggestions in system — shape branch skipped (route still wired)')
  } else {
    ok(`200 with ${data.suggestions.length} suggestion(s)`)
    const s = data.suggestions[0]
    if (Array.isArray(s.byLocation)) ok('suggestion.byLocation is an array')
    else bad('suggestion.byLocation missing', JSON.stringify(s).slice(0, 300))
    if (typeof s.totalAvailable === 'number') ok(`suggestion.totalAvailable is a number (${s.totalAvailable})`)
    else bad('suggestion.totalAvailable missing')
    if (typeof s.stockSource === 'string') ok(`suggestion.stockSource = ${s.stockSource}`)
    else bad('suggestion.stockSource missing')
    if (Array.isArray(s.channelCover)) ok(`suggestion.channelCover is an array (length=${s.channelCover.length})`)
    else bad('suggestion.channelCover missing')

    // No double-counting: sum of byLocation[i].available must equal totalAvailable
    if (s.byLocation.length > 0) {
      const sum = s.byLocation.reduce((acc, r) => acc + (r.available ?? 0), 0)
      if (sum === s.totalAvailable) ok(`no double-counting: Σ(byLocation.available)=${sum} === totalAvailable`)
      else bad(`double-counting suspected: Σ=${sum}, totalAvailable=${s.totalAvailable}`)
    }
  }
}

// ─── Branch 2: forecast-detail returns multi-location ATP ───
{
  // Find any product to probe
  const listRes = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const listData = await listRes.json().catch(() => ({}))
  const sampleProductId = listData?.suggestions?.[0]?.productId ?? null
  if (!sampleProductId) {
    ok('No products to probe forecast-detail — branch skipped')
  } else {
    const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/${sampleProductId}/forecast-detail`)
    const data = await res.json().catch(() => ({}))
    console.log(`[detail ${sampleProductId}] status=${res.status} byLoc=${data?.atp?.byLocation?.length} channels=${data?.channelCover?.length}`)
    if (res.status !== 200) {
      bad(`expected 200, got ${res.status}`)
    } else {
      ok('200 for forecast-detail')
      if (data?.atp && Array.isArray(data.atp.byLocation)) ok('atp.byLocation present')
      else bad('atp.byLocation missing', JSON.stringify(data?.atp).slice(0, 200))
      if (typeof data?.atp?.totalAvailable === 'number') ok(`atp.totalAvailable = ${data.atp.totalAvailable}`)
      else bad('atp.totalAvailable missing')
      if (typeof data?.atp?.stockSource === 'string') ok(`atp.stockSource = ${data.atp.stockSource}`)
      else bad('atp.stockSource missing')
      if (Array.isArray(data?.channelCover)) ok(`channelCover array (length=${data.channelCover.length})`)
      else bad('channelCover missing')
    }
  }
}

console.log(`\n[verify-replenishment-r2] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
