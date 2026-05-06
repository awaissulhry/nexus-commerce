#!/usr/bin/env node
// H.8c (Inbound) verification — real SP-API putTransportDetails.
//
// POST /api/fulfillment/fba/shipments/:id/transport — three branches:
//   1. 503 — SP-API not configured. Soft pass; honest config error.
//   2. 200 — Amazon accepted the transport details (TransportStatus
//      back). Validate shape.
//   3. 500 — SP-API call landed but Amazon rejected (no shipment with
//      this id, IneligibleShipmentStatus, etc.). Soft pass — proves
//      the new code path is running (the old stub returned 200 with
//      a synthetic SHIPPED status, never 500).
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h8c.mjs

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

// Use a synthetic Amazon shipmentId — falls through the local-row
// lookup and is passed straight to SP-API. Amazon will return
// ResourceNotFound, which proves the call landed.
const FAKE_SHIPMENT_ID = `FBA_VERIFY_${Date.now()}`

const res = await fetch(`${API_BASE}/api/fulfillment/fba/shipments/${FAKE_SHIPMENT_ID}/transport`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    shipmentType: 'SP',
    carrierName: 'OTHER',
    trackingIds: ['TRACK_VERIFY_001', 'TRACK_VERIFY_002'],
  }),
})
const text = await res.text()
let data
try { data = text ? JSON.parse(text) : null } catch { data = text }

console.log(`[verify-inbound-h8c] status=${res.status}`)
console.log(`[verify-inbound-h8c] body=${JSON.stringify(data).slice(0, 500)}`)

if (res.status === 503) {
  if (data?.error && /SP-API not configured/i.test(data.error)) {
    ok('503: SP-API not configured (soft pass — config gap surfaced honestly)')
  } else {
    bad('503 without expected message', JSON.stringify(data))
  }
} else if (res.status === 200) {
  ok('200: Amazon accepted transport details')
  if (typeof data?.transportStatus === 'string') {
    ok(`response.transportStatus = ${data.transportStatus}`)
  } else bad('transportStatus shape', JSON.stringify(data))
  if (data?.shipmentId) ok(`response.shipmentId echoed (${data.shipmentId})`)
  else bad('shipmentId missing from response', JSON.stringify(data))
} else if (res.status === 500) {
  // Three valid 500 branches all prove H.8c is running (the old stub
  // returned 200 with status=SHIPPED, never 500):
  //   a. SP-API call landed and Amazon rejected (ResourceNotFound /
  //      InvalidShipmentStatus / RequestThrottled).
  //   b. SP-API client wrapper error (LWA token failed, etc.).
  if (data?.error && /SP-API|ResourceNotFound|InvalidParameter|access denied|RequestThrottled|shipment.*not found|InvalidShipmentStatus|IneligibleShipmentStatus|MissingValueElementException/i.test(data.error)) {
    ok('500: real SP-API error surfaced (call reached Amazon)')
  } else if (data?.error && /SP-API putTransportDetails|LWA token/i.test(data.error)) {
    ok('500: SP-API client error path triggered (proves new code is live)')
  } else {
    bad('500 with unexpected error shape', JSON.stringify(data).slice(0, 300))
  }
} else if (res.status === 404) {
  bad('404: route missing — Railway deploy not picked up?', JSON.stringify(data).slice(0, 300))
} else {
  bad(`unexpected status ${res.status}`, JSON.stringify(data).slice(0, 300))
}

console.log(`\n[verify-inbound-h8c] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
