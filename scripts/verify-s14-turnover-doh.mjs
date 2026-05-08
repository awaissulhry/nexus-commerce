#!/usr/bin/env node
/**
 * S.14 verification — turnover + DoH analytics surface.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8') + '\n' + fs.readFileSync(path.join(here, '..', 'apps/web/src/components/inventory/StockSubNav.tsx'), 'utf8')
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
if (/fastify\.get\('\/stock\/analytics\/turnover'/.test(stockRoutes)) {
  ok('GET /api/stock/analytics/turnover registered')
} else {
  bad('GET /api/stock/analytics/turnover registered')
}

// 2. Calculation: turnover formula uses (cogsCents / days) * 365 / avgInvValue
if (/cogsCents \/ days\) \* 365 \/ /.test(stockRoutes)) {
  ok('endpoint computes annualized turnover from window')
} else {
  bad('endpoint computes annualized turnover from window')
}

// 3. DoH formula = 365 / turnover
if (/365 \/ turnoverRatio/.test(stockRoutes)) ok('endpoint computes DoH = 365 / turnover')
else bad('endpoint computes DoH = 365 / turnover')

// 4. Days param capped at 365
if (/Math\.min\(365,\s*Math\.max\(1/.test(stockRoutes)) ok('days query param clamped to [1, 365]')
else bad('days query param clamped to [1, 365]')

// 5. Frontend page + client exist
const page = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/analytics/page.tsx')
if (fs.existsSync(page)) ok('analytics/page.tsx exists')
else bad('analytics/page.tsx exists')

// 6. Frontend hits the right endpoint
if (/api\/stock\/analytics\/turnover/.test(analyticsClient)) ok('AnalyticsClient calls /api/stock/analytics/turnover')
else bad('AnalyticsClient calls /api/stock/analytics/turnover')

// 7. Period selector + sortable columns
if (/PERIOD_OPTIONS/.test(analyticsClient) && /\b7\b.*\b30\b.*\b365\b/s.test(analyticsClient)) {
  ok('period selector with 7/30/90/180/365 options')
} else {
  bad('period selector with 7/30/90/180/365 options')
}
if (/SortKey/.test(analyticsClient) && /setSortKey\('turnover'\)/.test(analyticsClient)) {
  ok('sortable per-product table')
} else {
  bad('sortable per-product table')
}

// 8. DoH tone helper for visual cues
if (/dohTone/.test(analyticsClient)) ok('DoH tone helper for colour coding')
else bad('DoH tone helper for colour coding')

// 9. Workspace links to analytics
if (/\/fulfillment\/stock\/analytics/.test(stockWorkspace)) {
  ok('StockWorkspace links to /analytics')
} else {
  bad('StockWorkspace links to /analytics')
}

// 10. Catalog parity for new keys
const newKeys = [
  'stock.analytics.title', 'stock.analytics.description', 'stock.analytics.period',
  'stock.analytics.kpi.turnover', 'stock.analytics.kpi.doh',
  'stock.analytics.kpi.cogs', 'stock.analytics.kpi.inventoryValue',
  'stock.analytics.byChannel.title', 'stock.analytics.col.units',
  'stock.analytics.col.turnover', 'stock.analytics.col.doh',
  'stock.analytics.empty.title',
]
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  // Common acronyms (COGS, FBA, SKU, SP-API) read identically in
  // Italian — operators recognise them as proper nouns.
  const ACRONYMS = new Set(['COGS', 'FBA', 'SKU', 'API'])
  if (en[k] && it[k] && en[k] === it[k] && !ACRONYMS.has(en[k])) {
    bad(`${k} translated (en !== it)`)
  }
}

console.log()
console.log(`[S.14 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
