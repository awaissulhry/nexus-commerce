#!/usr/bin/env node
/**
 * S.19 verification — EOQ + Reorder Point recommendations.
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

// 1. Backend endpoints
if (/fastify\.get\('\/stock\/analytics\/eoq'/.test(stockRoutes)) ok('GET /api/stock/analytics/eoq registered')
else bad('GET /api/stock/analytics/eoq registered')
if (/fastify\.post[\s\S]*?'\/stock\/analytics\/eoq\/apply'/.test(stockRoutes)) {
  ok('POST /api/stock/analytics/eoq/apply registered')
} else {
  bad('POST /api/stock/analytics/eoq/apply registered')
}

// 2. Wilson formula present
if (/Math\.sqrt\(\(2 \* annualDemand \* orderCostCents\) \/ annualHoldingCostCents\)/.test(stockRoutes)) {
  ok('endpoint computes Wilson EOQ formula')
} else {
  bad('endpoint computes Wilson EOQ formula')
}

// 3. ROP = leadTime × daily + safetyStock
if (/leadTimeDays \* dailyDemand \+ safetyStock/.test(stockRoutes)) ok('endpoint computes ROP = leadTime×daily + safetyStock')
else bad('endpoint computes ROP = leadTime×daily + safetyStock')

// 4. Safety stock with Z-score from service level
if (/zFromServiceLevel/.test(stockRoutes) && /z \* stddev \* Math\.sqrt\(leadTimeDays\)/.test(stockRoutes)) {
  ok('endpoint computes safety stock = Z × σ × √leadTime')
} else {
  bad('endpoint computes safety stock = Z × σ × √leadTime')
}

// 5. Defaults wired (order cost €25, carrying 25%, lead time 14d, service 95%)
if (/DEFAULT_ORDER_COST_CENTS = 2500/.test(stockRoutes)) ok('default order cost €25')
else bad('default order cost €25')
if (/DEFAULT_CARRYING_PCT = 0\.25/.test(stockRoutes)) ok('default carrying cost 25%')
else bad('default carrying cost 25%')
if (/DEFAULT_LEAD_TIME = 14/.test(stockRoutes)) ok('default lead time 14d')
else bad('default lead time 14d')
if (/DEFAULT_SERVICE_LEVEL = 95/.test(stockRoutes)) ok('default service level 95%')
else bad('default service level 95%')

// 6. Apply endpoint validates non-negative integers
if (/reorderThreshold must be null or a non-negative integer/.test(stockRoutes)) {
  ok('apply endpoint validates reorderThreshold')
} else {
  bad('apply endpoint validates reorderThreshold')
}

// 7. Frontend type + fetch + apply
if (/EoqResponse/.test(analyticsClient)) ok('AnalyticsClient defines EoqResponse')
else bad('AnalyticsClient defines EoqResponse')
if (/api\/stock\/analytics\/eoq\?days=/.test(analyticsClient)) ok('AnalyticsClient fetches /api/stock/analytics/eoq')
else bad('AnalyticsClient fetches /api/stock/analytics/eoq')
if (/applyRecommendation = useCallback/.test(analyticsClient)) ok('applyRecommendation callback')
else bad('applyRecommendation callback')
if (/api\/stock\/analytics\/eoq\/apply/.test(analyticsClient)) ok('AnalyticsClient posts to apply endpoint')
else bad('AnalyticsClient posts to apply endpoint')

// 8. Catalog parity
const newKeys = [
  'stock.eoq.title', 'stock.eoq.windowSummary',
  'stock.eoq.col.product', 'stock.eoq.col.location', 'stock.eoq.col.demand',
  'stock.eoq.col.currentRop', 'stock.eoq.col.recommendedRop', 'stock.eoq.col.recommendedEoq',
  'stock.eoq.apply', 'stock.eoq.appliedToast',
  'stock.eoq.formula.title', 'stock.eoq.formula.body',
]
// Words that are identical in en + it (acronyms or shared
// vocabulary). 'Formula' is the same word in both languages;
// 'Apply' is reasonable to share too in tech UIs.
const ACRONYMS = new Set(['COGS', 'FBA', 'SKU', 'API', 'EOQ', 'ROP', 'Formula'])
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
console.log(`[S.19 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
