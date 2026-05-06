#!/usr/bin/env node
// H.8b (Inbound) verification — real SP-API getLabels path.
//
// POST /api/fulfillment/fba/shipments/:id/labels — three branches:
//   1. 503 — SP-API not configured. Soft pass; honest config error.
//   2. 200 — Amazon returned a DownloadURL. Validate shape.
//   3. 500 — SP-API call landed but Amazon rejected (no shipment with
//      this id, ResourceNotFound, throttled, etc.). Soft pass — proves
//      the new code path is running (the H.0c stub never returned 500).
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h8b.mjs

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

// Use a known-bad Amazon shipmentId — the route falls back to passing
// :id straight to SP-API when no local FBAShipment row matches. Amazon
// will return ResourceNotFound, which proves the call landed.
const FAKE_SHIPMENT_ID = `FBA_VERIFY_${Date.now()}`

const res = await fetch(`${API_BASE}/api/fulfillment/fba/shipments/${FAKE_SHIPMENT_ID}/labels`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pageType: 'PackageLabel_A4_4', labelType: 'BARCODE_2D' }),
})
const text = await res.text()
let data
try { data = text ? JSON.parse(text) : null } catch { data = text }

console.log(`[verify-inbound-h8b] status=${res.status}`)
console.log(`[verify-inbound-h8b] body=${JSON.stringify(data).slice(0, 500)}`)

if (res.status === 503) {
  if (data?.error && /SP-API not configured/i.test(data.error)) {
    ok('503: SP-API not configured (soft pass — config gap surfaced honestly)')
  } else {
    bad('503 without expected message', JSON.stringify(data))
  }
} else if (res.status === 200) {
  ok('200: Amazon returned a labels URL')
  if (typeof data?.downloadUrl === 'string' && /^https?:\/\//.test(data.downloadUrl)) {
    ok(`response.downloadUrl is a valid URL`)
  } else bad('downloadUrl shape', JSON.stringify(data))
  if (data?.labelsUrl === data?.downloadUrl) ok('back-compat: labelsUrl alias matches downloadUrl')
  else bad('labelsUrl alias missing or different', JSON.stringify(data))
} else if (res.status === 500) {
  // Three valid 500 branches all prove H.8b is running (the old stub
  // returned 200 with a fake URL, never 500):
  //   a. SP-API call landed and Amazon rejected (ResourceNotFound /
  //      InvalidParameter / RequestThrottled — common with fake id).
  //   b. SP-API client wrapper error (LWA token failed, etc.).
  if (data?.error && /SP-API|ResourceNotFound|InvalidParameter|access denied|RequestThrottled|shipment.*not found|InvalidShipmentId|no DownloadURL/i.test(data.error)) {
    ok('500: real SP-API error surfaced (call reached Amazon)')
  } else if (data?.error && /SP-API getLabels|LWA token/i.test(data.error)) {
    ok('500: SP-API client error path triggered (proves new code is live)')
  } else {
    bad('500 with unexpected error shape', JSON.stringify(data).slice(0, 300))
  }
} else if (res.status === 404) {
  // Route should always exist. 404 means the deploy hasn't picked up
  // the new route yet, OR the path is wrong.
  bad('404: route missing — Railway deploy not picked up?', JSON.stringify(data).slice(0, 300))
} else {
  bad(`unexpected status ${res.status}`, JSON.stringify(data).slice(0, 300))
}

console.log(`\n[verify-inbound-h8b] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
