#!/usr/bin/env node
/**
 * S.29 — Stockout history report verification.
 *
 * Asserts:
 *   1. Page + client files exist at /fulfillment/stock/stockouts.
 *   2. Client file calls the existing R.12 API endpoints.
 *   3. The route is linked from StockWorkspace.
 *   4. listStockoutEvents service accepts the new filters
 *      (locationId, sku, sinceDays).
 *   5. The 30+ stock.stockouts.* i18n keys are present in en + it
 *      and translations differ.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')

const failures = []

// 1. files exist
const PAGE = path.join(ROOT, 'apps/web/src/app/fulfillment/stock/stockouts/page.tsx')
const CLIENT = path.join(ROOT, 'apps/web/src/app/fulfillment/stock/stockouts/StockoutsClient.tsx')
if (!fs.existsSync(PAGE)) failures.push('missing page.tsx')
if (!fs.existsSync(CLIENT)) failures.push('missing StockoutsClient.tsx')

// 2. client calls the R.12 endpoints
if (fs.existsSync(CLIENT)) {
  const src = fs.readFileSync(CLIENT, 'utf8')
  if (!src.includes('/api/fulfillment/replenishment/stockouts/summary')) {
    failures.push('Client does not call the summary endpoint')
  }
  if (!src.includes('/api/fulfillment/replenishment/stockouts/events')) {
    failures.push('Client does not call the events endpoint')
  }
  if (!src.includes('/api/fulfillment/replenishment/stockouts/sweep')) {
    failures.push('Client does not expose the sweep trigger')
  }
}

// 3. StockWorkspace links to /fulfillment/stock/stockouts
const WS = path.join(ROOT, 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx')
const ws = fs.readFileSync(WS, 'utf8')
if (!ws.includes('href="/fulfillment/stock/stockouts"')) {
  failures.push('StockWorkspace has no link to /fulfillment/stock/stockouts')
}

// 4. service accepts new filters
const SVC = path.join(ROOT, 'apps/api/src/services/stockout-detector.service.ts')
const svc = fs.readFileSync(SVC, 'utf8')
for (const filter of ['locationId', 'sku', 'sinceDays']) {
  if (!new RegExp(`\\b${filter}\\?:`).test(svc)) {
    failures.push(`listStockoutEvents missing ${filter} filter`)
  }
}

// 5. i18n keys
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const IT = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const REQUIRED_KEYS = [
  'stock.stockouts.title',
  'stock.stockouts.description',
  'stock.stockouts.refresh',
  'stock.stockouts.sweep',
  'stock.stockouts.windowLabel',
  'stock.stockouts.locationLabel',
  'stock.stockouts.locationAny',
  'stock.stockouts.skuPlaceholder',
  'stock.stockouts.limitNote',
  'stock.stockouts.status.all',
  'stock.stockouts.status.open',
  'stock.stockouts.status.closed',
  'stock.stockouts.kpi.events',
  'stock.stockouts.kpi.open',
  'stock.stockouts.kpi.totalDays',
  'stock.stockouts.kpi.lostUnits',
  'stock.stockouts.kpi.lostRevenue',
  'stock.stockouts.kpi.lostMargin',
  'stock.stockouts.col.sku',
  'stock.stockouts.col.location',
  'stock.stockouts.col.started',
  'stock.stockouts.col.duration',
  'stock.stockouts.col.velocity',
  'stock.stockouts.col.lostUnits',
  'stock.stockouts.col.lostRevenue',
  'stock.stockouts.col.lostMargin',
  'stock.stockouts.col.detectedBy',
  'stock.stockouts.col.notes',
  'stock.stockouts.empty.title',
  'stock.stockouts.empty.description',
  'stock.stockouts.toast.sweepDone',
]

// Acronyms / brand names that legitimately stay identical between EN
// and IT (SKU, FBA, etc.).
const ACRONYMS = /^(SKU|FBA|MCF|EOQ|ROP|WAC|FIFO|LIFO|COGS|Pan-EU FBA|Cron)/i

for (const k of REQUIRED_KEYS) {
  if (!(k in EN)) failures.push(`en.json missing key: ${k}`)
  if (!(k in IT)) failures.push(`it.json missing key: ${k}`)
  if (k in EN && k in IT) {
    const en = String(EN[k]).trim()
    const it = String(IT[k]).trim()
    // Skip translation-equality check for short labels that are
    // legitimately identical (e.g., column header "SKU").
    if (en === it && !ACRONYMS.test(en) && en.length > 3) {
      failures.push(`${k}: en === it (likely missing IT translation)`)
    }
  }
}

if (failures.length === 0) {
  console.log(`✅ S.29 stockout-history verification clean (${REQUIRED_KEYS.length} i18n keys, both en + it translated)`)
  process.exit(0)
}

console.error(`❌ S.29 verification failed (${failures.length}):`)
for (const f of failures) console.error(`   - ${f}`)
process.exit(1)
