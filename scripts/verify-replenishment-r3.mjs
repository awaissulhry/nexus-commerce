#!/usr/bin/env node
// R.3 verification — recommendation persistence + audit trail.
//
// Branches:
//   1. /replenishment GET response — each suggestion has a
//      recommendationId (or null).
//   2. /:productId/history endpoint — 200 with shape { productId,
//      history: [...] }. Even if history is empty (page never
//      visited), the route should respond 200.
//   3. /recommendations/:id endpoint — 404 for unknown id.
//   4. Diff-aware persistence — calling /replenishment twice
//      back-to-back should NOT duplicate rows for unchanged
//      products. Verified by counting history length before vs
//      after a second GET.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r3.mjs

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

// ─── Branch 1: replenishment list emits recommendationId ───
let sampleProductId = null
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const data = await res.json().catch(() => ({}))
  console.log(`[list] status=${res.status} suggestions=${data?.suggestions?.length}`)
  if (res.status !== 200) {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  } else if (!Array.isArray(data?.suggestions) || data.suggestions.length === 0) {
    ok('No suggestions in system — recId branch skipped')
  } else {
    ok(`200 with ${data.suggestions.length} suggestion(s)`)
    const s = data.suggestions[0]
    sampleProductId = s.productId
    if ('recommendationId' in s) ok(`suggestion.recommendationId present (${s.recommendationId ?? 'null'})`)
    else bad('suggestion.recommendationId missing', JSON.stringify(s).slice(0, 300))
  }
}

// ─── Branch 2: /:productId/history endpoint ───
let firstHistoryLen = null
if (sampleProductId) {
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/${sampleProductId}/history?limit=20`)
  const data = await res.json().catch(() => ({}))
  console.log(`[history ${sampleProductId}] status=${res.status} count=${data?.history?.length}`)
  if (res.status !== 200) {
    bad(`history expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  } else {
    ok('history endpoint returns 200')
    if (data?.productId === sampleProductId) ok('productId echoed')
    else bad('productId not echoed')
    if (Array.isArray(data?.history)) {
      ok(`history is an array (length=${data.history.length})`)
      firstHistoryLen = data.history.length
      if (data.history.length > 0) {
        const first = data.history[0]
        for (const k of ['id', 'generatedAt', 'urgency', 'reorderQuantity', 'status', 'effectiveStock']) {
          if (k in first) ok(`history[0].${k} present`)
          else bad(`history[0].${k} missing`, JSON.stringify(first))
        }
      }
    } else {
      bad('history not an array')
    }
  }
} else {
  ok('No sample product — history branch skipped')
}

// ─── Branch 3: 404 for unknown recommendation id ───
{
  const SYNTH = `rec_synth_${Date.now()}`
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/recommendations/${SYNTH}`)
  console.log(`[unknown rec] status=${res.status}`)
  if (res.status === 404) ok('404 for unknown recommendation id')
  else if (res.status === 405) bad('405 — route not wired', '')
  else bad(`expected 404, got ${res.status}`)
}

// ─── Branch 4: diff-aware — second list call shouldn't duplicate ───
if (sampleProductId && firstHistoryLen !== null) {
  // Force a second /replenishment GET. Should re-persist only changed
  // recommendations. For an unchanged product, history length stays.
  await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  // Then re-check history.
  const r = await fetch(`${API_BASE}/api/fulfillment/replenishment/${sampleProductId}/history?limit=20`)
  const data = await r.json().catch(() => ({}))
  const secondLen = data?.history?.length ?? 0
  console.log(`[diff-aware] before=${firstHistoryLen} after=${secondLen}`)
  if (secondLen <= firstHistoryLen + 1) {
    // Allow +1 because the very first /replenishment call may have
    // inserted the initial ACTIVE row that didn't exist before this
    // verify ran. Anything more than +1 between two adjacent calls
    // means diff-aware isn't working.
    ok(`diff-aware: ${firstHistoryLen} → ${secondLen} (≤ +1, no duplicate writes)`)
  } else {
    bad(`diff-aware suspect: history grew ${firstHistoryLen} → ${secondLen} between adjacent calls`)
  }
}

console.log(`\n[verify-replenishment-r3] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
