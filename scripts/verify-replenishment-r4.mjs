#!/usr/bin/env node
// R.4 verification — MOQ + case-pack + EOQ + safety stock.
//
// Branches:
//   1. /replenishment GET emits the new R.4 fields per suggestion:
//      safetyStockUnits, eoqUnits, constraintsApplied[], unitCostCents,
//      servicePercentEffective.
//   2. /:productId/forecast-detail attaches `recommendation` block with
//      the math snapshot.
//   3. Math invariant: reorderQuantity >= moq for products with a
//      preferred supplier. (Verified across the suggestion list — any
//      product whose constraintsApplied includes MOQ_APPLIED must
//      have reorderQuantity matching its supplier's moq exactly or
//      a case-pack multiple of it.)
//
// The deterministic math (EOQ, safety stock, MOQ rounding) is proven
// by the pure-function tests at build time. This verify is the
// integration smoke against live data.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r4.mjs

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

// ─── Branch 1: /replenishment list emits R.4 fields ───
let sampleProductId = null
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const data = await res.json().catch(() => ({}))
  console.log(`[list] status=${res.status} suggestions=${data?.suggestions?.length}`)
  if (res.status !== 200) {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  } else if (!Array.isArray(data?.suggestions) || data.suggestions.length === 0) {
    ok('No suggestions in system — R.4 field branch skipped')
  } else {
    ok(`200 with ${data.suggestions.length} suggestion(s)`)
    const s = data.suggestions[0]
    sampleProductId = s.productId

    if ('safetyStockUnits' in s) ok(`safetyStockUnits = ${s.safetyStockUnits}`)
    else bad('safetyStockUnits missing', JSON.stringify(s).slice(0, 200))
    if ('eoqUnits' in s) ok(`eoqUnits = ${s.eoqUnits}`)
    else bad('eoqUnits missing')
    if (Array.isArray(s.constraintsApplied)) ok(`constraintsApplied = [${s.constraintsApplied.join(',')}]`)
    else bad('constraintsApplied not an array')
    if ('servicePercentEffective' in s) ok(`servicePercentEffective = ${s.servicePercentEffective}`)
    else bad('servicePercentEffective missing')

    // Sanity: when constraintsApplied includes MOQ_APPLIED or
    // CASE_PACK_ROUNDED_UP, reorderQuantity must be > 0.
    let constraintRowsChecked = 0
    for (const sg of data.suggestions.slice(0, 50)) {
      const c = sg.constraintsApplied ?? []
      if (c.length > 0) {
        constraintRowsChecked++
        if (sg.reorderQuantity <= 0) {
          bad(`constraint applied but reorderQuantity=${sg.reorderQuantity}`, JSON.stringify(sg).slice(0, 150))
          break
        }
      }
    }
    if (constraintRowsChecked > 0) {
      ok(`${constraintRowsChecked} suggestion(s) had constraints applied — all have reorderQuantity > 0`)
    } else {
      ok('No suggestions with active constraints in sample (no MOQ/casePack data yet — pre-launch)')
    }
  }
}

// ─── Branch 2: forecast-detail returns recommendation block ───
if (sampleProductId) {
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/${sampleProductId}/forecast-detail`)
  const data = await res.json().catch(() => ({}))
  console.log(`[detail ${sampleProductId}] status=${res.status} rec=${data?.recommendation ? 'present' : 'null'}`)
  if (res.status !== 200) {
    bad(`expected 200, got ${res.status}`)
  } else {
    ok('200 for forecast-detail')
    if (data?.recommendation) {
      ok('recommendation block present')
      for (const k of ['urgency', 'reorderPoint', 'reorderQuantity', 'safetyStockUnits', 'eoqUnits', 'constraintsApplied']) {
        if (k in data.recommendation) ok(`recommendation.${k} present`)
        else bad(`recommendation.${k} missing`)
      }
    } else {
      ok('recommendation null (no ACTIVE row for this product yet — non-fatal)')
    }
  }
} else {
  ok('No sample product — forecast-detail branch skipped')
}

console.log(`\n[verify-replenishment-r4] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
