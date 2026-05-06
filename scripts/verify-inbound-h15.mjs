#!/usr/bin/env node
// H.15 verification — server-side carrier registry.
//
//   GET  /api/fulfillment/carriers/inbound  → { items: [{code,label,country?,pattern?}] }
//   POST /api/fulfillment/carriers/inbound/validate-tracking
//        body: { carrierCode, trackingNumber }
//        returns: { valid: boolean, pattern?: string, reason?: string }
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h15.mjs

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

// ─── Branch 1: list carriers ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/carriers/inbound`)
  const data = await res.json().catch(() => ({}))
  console.log(`[list] status=${res.status} count=${data?.items?.length}`)
  if (res.status !== 200) {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  } else if (!Array.isArray(data?.items)) {
    bad('items not an array', JSON.stringify(data).slice(0, 200))
  } else {
    ok(`200 with ${data.items.length} carriers`)
    if (data.items.length >= 5) ok('at least 5 carriers in registry')
    else bad(`expected 5+ carriers, got ${data.items.length}`)
    for (const c of data.items) {
      if (typeof c.code === 'string' && typeof c.label === 'string') continue
      bad('malformed carrier entry', JSON.stringify(c).slice(0, 100))
      break
    }
    if (data.items.find((c) => c.code === 'BRT')) ok('BRT present (Italian primary)')
    else bad('BRT missing')
    if (data.items.find((c) => c.code === 'DHL')) ok('DHL present (international primary)')
    else bad('DHL missing')
  }
}

// ─── Branch 2: validate-tracking happy path ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/carriers/inbound/validate-tracking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carrierCode: 'UPS', trackingNumber: '1Z999AA10123456784' }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[validate UPS valid] status=${res.status} body=${JSON.stringify(data)}`)
  if (res.status === 200 && data?.valid === true) ok('validate UPS happy: { valid: true }')
  else bad('validate UPS happy failed', JSON.stringify(data))
}

// ─── Branch 3: validate-tracking format mismatch ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/carriers/inbound/validate-tracking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carrierCode: 'DHL', trackingNumber: 'NOT_A_DHL_NUMBER' }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[validate DHL bad] status=${res.status} body=${JSON.stringify(data)}`)
  if (res.status === 200 && data?.valid === false && typeof data?.reason === 'string') {
    ok('validate DHL bad: { valid: false, reason: ... }')
  } else bad('validate DHL bad failed', JSON.stringify(data))
}

// ─── Branch 4: unknown carrier → permissive valid:true ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/carriers/inbound/validate-tracking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carrierCode: 'NOT_REAL', trackingNumber: 'WHATEVER' }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[validate unknown] status=${res.status} body=${JSON.stringify(data)}`)
  if (res.status === 200 && data?.valid === true) ok('unknown carrier returns permissive valid:true')
  else bad('unknown carrier validation unexpected', JSON.stringify(data))
}

console.log(`\n[verify-inbound-h15] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
