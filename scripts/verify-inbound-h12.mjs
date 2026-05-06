#!/usr/bin/env node
// H.12 (Inbound) verification — QC queue endpoint + KPI extension.
//
//   GET /api/fulfillment/inbound/qc-queue → { count, items[] }.
//   GET /api/fulfillment/inbound/kpis     → must include qcQueueCount.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h12.mjs

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

// ─── Branch 1: GET qc-queue ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/qc-queue`)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  console.log(`[GET qc-queue] status=${res.status} count=${data?.count} items.length=${data?.items?.length}`)
  if (res.status === 200) {
    ok('GET /qc-queue returns 200')
    if (typeof data?.count === 'number') ok(`count is a number (${data.count})`)
    else bad('count missing', JSON.stringify(data))
    if (Array.isArray(data?.items)) ok(`items is an array (length=${data.items.length})`)
    else bad('items not an array', JSON.stringify(data))
    if (data?.count === data?.items?.length) ok('count matches items.length')
    else bad(`count (${data?.count}) != items.length (${data?.items?.length})`)
  } else if (res.status === 404) {
    bad('404: route missing — Railway not redeployed yet?', JSON.stringify(data).slice(0, 200))
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 300))
  }
}

// ─── Branch 2: KPI now includes qcQueueCount ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/kpis`)
  const data = await res.json().catch(() => ({}))
  console.log(`[GET kpis] qcQueueCount=${data?.qcQueueCount}`)
  if (res.status === 200) {
    if (typeof data?.qcQueueCount === 'number') {
      ok(`kpis.qcQueueCount is a number (${data.qcQueueCount})`)
    } else {
      bad('kpis.qcQueueCount missing — KPI not extended', JSON.stringify(data).slice(0, 200))
    }
  } else {
    bad(`kpis: unexpected status ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

console.log(`\n[verify-inbound-h12] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
