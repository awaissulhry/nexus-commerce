#!/usr/bin/env node
// H.3 (Inbound) verification — list endpoint pagination/search/sort
// + KPI endpoint shape.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h3.mjs

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
async function api(method, p) {
  const res = await fetch(`${API_BASE}${p}`, { method })
  const text = await res.text()
  let data; try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

// 1. List endpoint with pagination + sort
const list1 = await api('GET', '/api/fulfillment/inbound?page=1&pageSize=10&sortBy=createdAt&sortDir=desc')
if (list1.ok) ok('GET /api/fulfillment/inbound (paginated)')
else bad('GET inbound paginated', `${list1.status}`)
if (list1.data && typeof list1.data.total === 'number' && typeof list1.data.totalPages === 'number') ok('response shape: total + totalPages')
else bad('response shape', JSON.stringify(list1.data).slice(0, 200))
if (Array.isArray(list1.data?.items) && list1.data.items.length <= 10) ok('respects pageSize cap')
else bad('pageSize cap', `got ${list1.data?.items?.length}`)

// 2. Sort variants don't error
const sorts = ['expectedAt', 'status', 'type', 'updatedAt']
for (const sb of sorts) {
  const r = await api('GET', `/api/fulfillment/inbound?sortBy=${sb}`)
  if (r.ok) ok(`sortBy=${sb}`)
  else bad(`sortBy=${sb}`, `${r.status}`)
}

// 3. Status multi-select
const r2 = await api('GET', '/api/fulfillment/inbound?status=DRAFT,SUBMITTED')
if (r2.ok) ok('status= multi-select (comma-separated)')
else bad('multi-status', `${r2.status}`)

// 4. Search no-error
const r3 = await api('GET', '/api/fulfillment/inbound?search=NONEXISTENT_SKU_XYZ_999')
if (r3.ok && Array.isArray(r3.data?.items)) ok('search query returns array (likely empty)')
else bad('search query', JSON.stringify(r3.data).slice(0, 200))

// 5. KPI endpoint
const kpi = await api('GET', '/api/fulfillment/inbound/kpis')
if (kpi.ok) ok('GET /api/fulfillment/inbound/kpis')
else bad('GET kpis', `${kpi.status}`)
if (kpi.data && typeof kpi.data.openShipments === 'number') ok('kpis.openShipments is number')
else bad('kpis.openShipments', JSON.stringify(kpi.data).slice(0, 200))
if (kpi.data && typeof kpi.data.openDiscrepancies === 'number') ok('kpis.openDiscrepancies is number')
else bad('kpis.openDiscrepancies', JSON.stringify(kpi.data).slice(0, 200))
if (kpi.data && typeof kpi.data.statusCounts === 'object' && kpi.data.statusCounts !== null) ok('kpis.statusCounts is object')
else bad('kpis.statusCounts', JSON.stringify(kpi.data).slice(0, 200))
if (kpi.data && typeof kpi.data.typeCounts === 'object' && kpi.data.typeCounts !== null) ok('kpis.typeCounts is object')
else bad('kpis.typeCounts', JSON.stringify(kpi.data).slice(0, 200))

console.log(`\n[verify-inbound-h3] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
