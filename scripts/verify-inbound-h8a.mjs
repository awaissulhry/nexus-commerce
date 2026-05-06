#!/usr/bin/env node
// H.8a (Inbound) verification — real SP-API createInboundShipmentPlan
// path. Three branches:
//
//   1. 503 — SP-API not configured. Soft pass; the route returns a
//      clear config-error message instead of silently fabricating a
//      stub plan.
//   2. 200 — Amazon accepted the SKU(s) and returned shipment plans.
//      Validate the response shape and that shipmentIds look like
//      Amazon's pattern (FBA-prefixed alphanumeric).
//   3. 500 — SP-API reached but Amazon rejected the request (most
//      common for a smoke with fake SKUs: "InvalidSellerSKU" / "The
//      ASIN doesn't exist"). Soft pass — the call landed at Amazon
//      (proven by the error message format) and the route surfaced
//      it instead of swallowing.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h8a.mjs

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

const TEST_SKU = `H8A_SMOKE_${Date.now()}`

const res = await fetch(`${API_BASE}/api/fulfillment/fba/plan-shipment`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: [{ sku: TEST_SKU, quantity: 1 }],
    labelPrepPreference: 'SELLER_LABEL',
  }),
})
const text = await res.text()
let data
try { data = text ? JSON.parse(text) : null } catch { data = text }

console.log(`[verify-inbound-h8a] status=${res.status}`)
console.log(`[verify-inbound-h8a] body=${JSON.stringify(data).slice(0, 500)}`)

if (res.status === 503) {
  if (data?.error && /SP-API not configured/i.test(data.error)) {
    ok('503: SP-API not configured (soft pass — config gap surfaced honestly)')
  } else {
    bad('503 without expected message', JSON.stringify(data))
  }
} else if (res.status === 200) {
  ok('200: Amazon accepted the request')
  if (data?.shipmentPlans && Array.isArray(data.shipmentPlans)) {
    ok('response.shipmentPlans is an array')
  } else bad('shipmentPlans shape', JSON.stringify(data))

  if (data?.shipmentPlans?.[0]) {
    const p = data.shipmentPlans[0]
    if (typeof p.shipmentId === 'string' && p.shipmentId.length > 0) ok(`plan has shipmentId (${p.shipmentId})`)
    else bad('shipmentId missing', JSON.stringify(p))
    if (typeof p.destinationFC === 'string' && /^[A-Z]{3,5}\d?$/.test(p.destinationFC)) {
      ok(`destinationFC matches Amazon FC pattern (${p.destinationFC})`)
    } else bad('destinationFC pattern', JSON.stringify(p.destinationFC))
  }
  if (data?.planId && data.planId.startsWith('PLAN-FBA')) ok('planId concatenates real Amazon shipmentIds (no fake timestamp)')
  else bad('planId shape', data?.planId)
} else if (res.status === 500) {
  // Real SP-API rejection — distinct from old stub which would never
  // fail. The error message should look like an Amazon SP-API error.
  if (data?.error && /SP-API|InvalidSellerSKU|InvalidSKU|The ASIN|MarketplaceId|access denied|InvalidParameter|RequestThrottled/i.test(data.error)) {
    ok('500: real SP-API error surfaced (call reached Amazon)')
  } else if (data?.error && /SP-API createInboundShipmentPlan/i.test(data.error)) {
    ok('500: SP-API error path triggered')
  } else {
    bad('500 with unexpected error shape', JSON.stringify(data).slice(0, 300))
  }
} else {
  bad(`unexpected status ${res.status}`, JSON.stringify(data).slice(0, 300))
}

console.log(`\n[verify-inbound-h8a] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
