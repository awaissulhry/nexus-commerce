#!/usr/bin/env node
// R.18 verification — reservation-aware ATP.
//
// The fix is one line: route handler now uses
//   effectiveStock = (atp.totalAvailable ?? p.totalStock) + inboundWithinLeadTime
// instead of the previous
//   effectiveStock = p.totalStock + inboundWithinLeadTime.
//
// Even with zero reservations on every product (Xavia pre-launch
// state), we can still verify the new formula is in use by asserting
// the invariant:
//   effectiveStock === totalAvailable + inboundWithinLeadTime
// on every suggestion.
//
// Pre-R.18 this would fail whenever totalAvailable != p.totalStock
// (StockLevel synced fresh while Product.totalStock was stale or
// vice versa). Post-R.18 the invariant holds always.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r18.mjs

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

// ─── Branch 1: replenishment list invariant check ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const data = await res.json().catch(() => ({}))
  console.log(`[list] status=${res.status} suggestions=${data?.suggestions?.length}`)
  if (res.status !== 200) {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  } else if (!Array.isArray(data?.suggestions) || data.suggestions.length === 0) {
    ok('No suggestions in system — invariant branch skipped')
  } else {
    ok(`200 with ${data.suggestions.length} suggestion(s)`)

    // Sample first 50 to keep the assertion bounded.
    let invariantHolds = 0
    let invariantViolations = 0
    let fellBackToTotalStock = 0
    const violations = []
    for (const s of data.suggestions.slice(0, 50)) {
      const expected = (s.totalAvailable ?? s.currentStock) + s.inboundWithinLeadTime
      if (s.effectiveStock === expected) {
        invariantHolds++
        if (s.totalAvailable === 0 && s.currentStock !== 0) {
          // Suggestion had no StockLevel rows but Product.totalStock
          // was non-zero — fell through to fallback path. This is
          // the expected R.2 fallback behavior.
          fellBackToTotalStock++
        }
      } else {
        invariantViolations++
        if (violations.length < 3) {
          violations.push(`${s.sku}: effectiveStock=${s.effectiveStock}, expected=${expected} (totalAvail=${s.totalAvailable}, inbound=${s.inboundWithinLeadTime})`)
        }
      }
    }

    if (invariantViolations === 0) {
      ok(`R.18 invariant holds: effectiveStock = totalAvailable + inboundWithinLeadTime (${invariantHolds}/${invariantHolds} sampled)`)
    } else {
      bad(`R.18 invariant violated on ${invariantViolations} of ${invariantHolds + invariantViolations} sampled`, violations.join(' | '))
    }
    if (fellBackToTotalStock > 0) {
      ok(`R.2 fallback active on ${fellBackToTotalStock} legacy products (Product.totalStock used; expected pre-StockLevel-migration)`)
    }
  }
}

// ─── Branch 2: forecast-detail uses the same shape ───
{
  const listRes = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const listData = await listRes.json().catch(() => ({}))
  const sampleProductId = listData?.suggestions?.[0]?.productId ?? null
  if (!sampleProductId) {
    ok('No product to probe forecast-detail — skipped')
  } else {
    const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/${sampleProductId}/forecast-detail`)
    const data = await res.json().catch(() => ({}))
    if (res.status === 200) {
      ok('forecast-detail returns 200 (no regression)')
      if (data?.atp && typeof data.atp.totalAvailable === 'number') {
        ok(`atp.totalAvailable still present (${data.atp.totalAvailable})`)
      } else {
        bad('atp.totalAvailable missing — R.2 regression?', JSON.stringify(data?.atp).slice(0, 200))
      }
    } else {
      bad(`forecast-detail expected 200, got ${res.status}`)
    }
  }
}

console.log(`\n[verify-replenishment-r18] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
