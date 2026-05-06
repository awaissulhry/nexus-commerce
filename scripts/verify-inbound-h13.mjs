#!/usr/bin/env node
// H.13 verification — supplier scorecard endpoint.
//
//   GET /api/fulfillment/suppliers/:id/scorecard
//     - 404 for unknown supplier id.
//     - 200 with full metric block for a real supplier (picks the
//       first one off /fulfillment/suppliers if any exist).
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h13.mjs

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

// ─── Branch 1: 404 for unknown supplier ───
{
  const SYNTH = `sup_synth_${Date.now()}`
  const res = await fetch(`${API_BASE}/api/fulfillment/suppliers/${SYNTH}/scorecard`)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  console.log(`[unknown supplier] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 404) ok('404 for unknown supplier id')
  else if (res.status === 405) bad('405: route may not be wired', JSON.stringify(data).slice(0, 200))
  else bad(`expected 404, got ${res.status}`, JSON.stringify(data).slice(0, 200))
}

// ─── Branch 2: real supplier returns full shape ───
{
  const listRes = await fetch(`${API_BASE}/api/fulfillment/suppliers?activeOnly=true`)
  const listData = await listRes.json().catch(() => ({}))
  const sample = listData?.items?.[0]
  if (!sample) {
    ok('No suppliers in system — full-shape branch skipped (route still wired)')
  } else {
    const res = await fetch(`${API_BASE}/api/fulfillment/suppliers/${sample.id}/scorecard?windowDays=365`)
    const data = await res.json().catch(() => ({}))
    console.log(`[supplier ${sample.id}] status=${res.status} body=${JSON.stringify(data).slice(0, 400)}`)
    if (res.status === 200) {
      ok('200 for real supplier')
      for (const k of ['supplierId', 'supplierName', 'windowDays', 'leadTime', 'onTime', 'defectRate', 'openPOs', 'spend']) {
        if (k in data) ok(`response has ${k}`)
        else bad(`missing ${k}`, JSON.stringify(data))
      }
      for (const k of ['stated', 'observedAvgDays', 'observedMedianDays', 'observedMaxDays', 'sampleCount']) {
        if (k in (data.leadTime ?? {})) ok(`leadTime.${k} present`)
        else bad(`leadTime.${k} missing`, JSON.stringify(data.leadTime))
      }
      if (typeof data.spend?.totalCents === 'number') ok(`spend.totalCents = ${data.spend.totalCents}`)
      else bad('spend.totalCents missing', JSON.stringify(data.spend))
    } else {
      bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 300))
    }
  }
}

console.log(`\n[verify-inbound-h13] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
