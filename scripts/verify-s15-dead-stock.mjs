#!/usr/bin/env node
/**
 * S.15 verification — dead-stock + slow-moving identification.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const analyticsClient = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/analytics/AnalyticsClient.tsx'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Backend endpoint registered
if (/fastify\.get\('\/stock\/analytics\/dead-stock'/.test(stockRoutes)) {
  ok('GET /api/stock/analytics/dead-stock registered')
} else {
  bad('GET /api/stock/analytics/dead-stock registered')
}

// 2. Excludes migration / sync reasons from "movement" check
if (/notIn:\s*\[[\s\S]*?'PARENT_PRODUCT_CLEANUP'[\s\S]*?'STOCKLEVEL_BACKFILL'[\s\S]*?'SYNC_RECONCILIATION'/.test(stockRoutes)) {
  ok('endpoint excludes migration/sync reasons')
} else {
  bad('endpoint excludes migration/sync reasons')
}

// 3. Default 90 days, clamped [7, 365]
if (/safeNum\(q\.days,\s*90\)/.test(stockRoutes) && /Math\.min\(365,\s*Math\.max\(7/.test(stockRoutes)) {
  ok('days defaults 90 and clamps [7, 365]')
} else {
  bad('days defaults 90 and clamps [7, 365]')
}

// 4. Returns dead + slow with valueAtRisk
if (/dead:.*slow:/s.test(stockRoutes) && /valueAtRiskCents/.test(stockRoutes)) {
  ok('endpoint returns dead + slow with valueAtRiskCents')
} else {
  bad('endpoint returns dead + slow with valueAtRiskCents')
}

// 5. Frontend fetches dead-stock endpoint
if (/api\/stock\/analytics\/dead-stock\?days=/.test(analyticsClient)) {
  ok('AnalyticsClient fetches dead-stock')
} else {
  bad('AnalyticsClient fetches dead-stock')
}

// 6. Threshold selector with 30/60/90/180
if (/\[30,\s*60,\s*90,\s*180\]\.map/.test(analyticsClient)) {
  ok('AnalyticsClient has dead-stock threshold selector (30/60/90/180)')
} else {
  bad('AnalyticsClient has dead-stock threshold selector (30/60/90/180)')
}

// 7. Renders dead + slow columns
if (/deadStock\.dead/.test(analyticsClient) && /deadStock\.slow/.test(analyticsClient)) {
  ok('AnalyticsClient renders dead + slow columns')
} else {
  bad('AnalyticsClient renders dead + slow columns')
}

// 8. Recommended actions footer
if (/stock\.deadStock\.recommended\.title/.test(analyticsClient)) {
  ok('AnalyticsClient surfaces recommended actions footer')
} else {
  bad('AnalyticsClient surfaces recommended actions footer')
}

// 9. Catalog parity
const newKeys = [
  'stock.deadStock.title', 'stock.deadStock.threshold',
  'stock.deadStock.dead.title', 'stock.deadStock.slow.title',
  'stock.deadStock.atRisk', 'stock.deadStock.neverMoved',
  'stock.deadStock.recommended.title', 'stock.deadStock.recommended.body',
]
const ACRONYMS = new Set(['COGS', 'FBA', 'SKU', 'API'])
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k] && !ACRONYMS.has(en[k])) {
    bad(`${k} translated`)
  }
}

console.log()
console.log(`[S.15 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
