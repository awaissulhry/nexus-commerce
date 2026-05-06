#!/usr/bin/env node
// H.10a (Inbound) verification — cross-shipment scan-receive
// candidates endpoint.
//
// GET /api/fulfillment/inbound/receive-candidates?sku=<sku>
//   - 400 when sku param missing.
//   - 200 with { sku, count, candidates: [...] } otherwise.
//   - candidates only includes items with quantityReceived < quantityExpected.
//   - candidates only includes shipments NOT in terminal status
//     (RECEIVED / RECONCILED / CLOSED / CANCELLED).
//
// We use a synthetic SKU so we don't depend on real catalog data —
// the endpoint should return count=0 cleanly for an unknown SKU,
// proving the query/filter logic runs end-to-end.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h10a.mjs

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

// ─── Branch 1: missing sku param → 400 ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/receive-candidates`)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  console.log(`[no-sku] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 400 && data?.error && /sku/i.test(data.error)) {
    ok('400 when sku param missing')
  } else if (res.status === 404) {
    bad('404: route missing — Railway not deployed yet?', JSON.stringify(data).slice(0, 200))
  } else {
    bad(`expected 400, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 2: synthetic SKU → 200 with empty candidates ───
{
  const SYNTH_SKU = `H10A_SMOKE_${Date.now()}`
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/receive-candidates?sku=${encodeURIComponent(SYNTH_SKU)}`)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  console.log(`[synthetic-sku] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)
  if (res.status === 200) {
    ok('200 for synthetic SKU')
    if (data?.sku === SYNTH_SKU) ok('sku echoed back')
    else bad('sku not echoed', JSON.stringify(data))
    if (typeof data?.count === 'number') ok(`count is a number (${data.count})`)
    else bad('count missing', JSON.stringify(data))
    if (Array.isArray(data?.candidates)) ok(`candidates is an array (length=${data.candidates.length})`)
    else bad('candidates is not an array', JSON.stringify(data))
    if (data?.count === 0) ok('synthetic SKU returns 0 candidates (expected for unknown SKU)')
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 300))
  }
}

console.log(`\n[verify-inbound-h10a] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
