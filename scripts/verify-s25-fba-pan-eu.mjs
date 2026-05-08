#!/usr/bin/env node
/**
 * S.25 verification — Pan-EU FBA distribution view.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const schema = fs.readFileSync(path.join(here, '..', 'packages/database/prisma/schema.prisma'), 'utf8')
const service = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/fba-pan-eu.service.ts'), 'utf8')
const job = fs.readFileSync(path.join(here, '..', 'apps/api/src/jobs/fba-pan-eu-sync.job.ts'), 'utf8')
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const apiIndex = fs.readFileSync(path.join(here, '..', 'apps/api/src/index.ts'), 'utf8')
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8') + '\n' + fs.readFileSync(path.join(here, '..', 'apps/web/src/components/inventory/StockSubNav.tsx'), 'utf8')
const migrationDir = path.join(here, '..', 'packages/database/prisma/migrations/20260508_s25_fba_pan_eu')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Migration
if (fs.existsSync(path.join(migrationDir, 'migration.sql'))) ok('migration.sql exists')
else bad('migration.sql exists')
if (fs.existsSync(path.join(migrationDir, 'rollback.sql'))) ok('rollback.sql exists')
else bad('rollback.sql exists')
const migrationSql = fs.readFileSync(path.join(migrationDir, 'migration.sql'), 'utf8')
if (/CREATE TABLE IF NOT EXISTS "FbaInventoryDetail"/.test(migrationSql)) ok('migration creates FbaInventoryDetail')
else bad('migration creates FbaInventoryDetail')
if (/UNIQUE INDEX[\s\S]*?sku.*marketplaceId.*fulfillmentCenterId.*condition/i.test(migrationSql)) {
  ok('migration adds composite unique index')
} else {
  bad('migration adds composite unique index')
}

// 2. Schema declarations
if (/model FbaInventoryDetail/.test(schema)) ok('schema declares FbaInventoryDetail')
else bad('schema declares FbaInventoryDetail')
if (/fbaInventoryDetails\s+FbaInventoryDetail\[\]/.test(schema)) ok('Product has fbaInventoryDetails relation')
else bad('Product has fbaInventoryDetails relation')

// 3. Service exports
const exportsExpected = [
  'export async function syncFbaPanEuInventory',
  'export async function listPerFcTotals',
  'export async function getAgedInventory',
  'export async function getUnfulfillable',
  'export async function getPanEuSnapshot',
  'export const fbaPanEuUnconfiguredAdapter',
]
for (const e of exportsExpected) {
  if (service.includes(e)) ok(`service has ${e.replace('export async function ', '').replace('export const ', '')}`)
  else bad(`service has ${e.replace('export async function ', '').replace('export const ', '')}`)
}

// 4. firstReceivedAt preserved on update
if (/firstReceivedAt: existing\.firstReceivedAt \?\? firstReceivedAt/.test(service)) {
  ok('upsert preserves firstReceivedAt on update')
} else {
  bad('upsert preserves firstReceivedAt on update')
}

// 5. 5 conditions handled in per-FC totals
const conditions = ['SELLABLE', 'UNFULFILLABLE', 'INBOUND', 'RESERVED', 'RESEARCHING']
for (const c of conditions) {
  if (new RegExp(`condition === '${c}'`).test(service)) ok(`per-FC totals handles ${c}`)
  else bad(`per-FC totals handles ${c}`)
}

// 6. Aged inventory threshold defaults to 180 days
if (/thresholdDays \?\? 180/.test(service)) ok('aged inventory default threshold = 180 days')
else bad('aged inventory default threshold = 180 days')

// 7. Cron schedule + opt-out + apiIndex registration
if (/0 3 \* \* \*/.test(job)) ok('cron schedule = daily 03:00 UTC')
else bad('cron schedule = daily 03:00 UTC')
if (/NEXUS_ENABLE_FBA_PAN_EU_CRON/.test(job)) ok('cron has opt-out env')
else bad('cron has opt-out env')
if (/import \{ startFbaPanEuSyncCron \}/.test(apiIndex)) ok('apiIndex imports cron')
else bad('apiIndex imports cron')
if (/startFbaPanEuSyncCron\(\)/.test(apiIndex)) ok('apiIndex starts cron')
else bad('apiIndex starts cron')

// 8. Routes
if (/'\/stock\/fba-pan-eu'/.test(stockRoutes)) ok('GET /api/stock/fba-pan-eu registered')
else bad('GET /api/stock/fba-pan-eu registered')
if (/'\/stock\/fba-pan-eu\/aged'/.test(stockRoutes)) ok('GET /api/stock/fba-pan-eu/aged registered')
else bad('GET /api/stock/fba-pan-eu/aged registered')
if (/'\/stock\/fba-pan-eu\/unfulfillable'/.test(stockRoutes)) ok('GET /api/stock/fba-pan-eu/unfulfillable registered')
else bad('GET /api/stock/fba-pan-eu/unfulfillable registered')

// 9. Frontend
const pagePath = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/fba-pan-eu/page.tsx')
const clientPath = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/fba-pan-eu/FbaPanEuClient.tsx')
if (fs.existsSync(pagePath)) ok('fba-pan-eu/page.tsx exists')
else bad('fba-pan-eu/page.tsx exists')
if (fs.existsSync(clientPath)) ok('fba-pan-eu/FbaPanEuClient.tsx exists')
else bad('fba-pan-eu/FbaPanEuClient.tsx exists')
const client = fs.readFileSync(clientPath, 'utf8')
if (/api\/stock\/fba-pan-eu/.test(client)) ok('client fetches /api/stock/fba-pan-eu')
else bad('client fetches /api/stock/fba-pan-eu')
if (/MARKETPLACE_LABEL/.test(client)) ok('client maps marketplace IDs to country codes')
else bad('client maps marketplace IDs to country codes')
if (/ageTone/.test(client)) ok('client renders age-tinted DoH/age cells')
else bad('client renders age-tinted DoH/age cells')
if (/\/fulfillment\/inbound\?status=IN_TRANSIT&channel=AMAZON/.test(client)) {
  ok('client cross-links to /fulfillment/inbound')
} else {
  bad('client cross-links to /fulfillment/inbound')
}

// 10. Workspace link
if (/\/fulfillment\/stock\/fba-pan-eu/.test(stockWorkspace)) ok('workspace links to /fba-pan-eu')
else bad('workspace links to /fba-pan-eu')

// 11. Catalog parity
const newKeys = [
  'stock.fbaPanEu.title', 'stock.fbaPanEu.description',
  'stock.fbaPanEu.inboundLink',
  'stock.fbaPanEu.cond.sellable', 'stock.fbaPanEu.cond.inbound',
  'stock.fbaPanEu.cond.reserved', 'stock.fbaPanEu.cond.unfulfillable',
  'stock.fbaPanEu.cond.researching',
  'stock.fbaPanEu.aged.title', 'stock.fbaPanEu.aged.subtitle',
  'stock.fbaPanEu.unfulfillable.title', 'stock.fbaPanEu.unfulfillable.subtitle',
  'stock.fbaPanEu.unfulfillable.footer',
  'stock.fbaPanEu.empty.title', 'stock.fbaPanEu.empty.description',
]
const ACRONYMS = new Set(['FBA', 'SKU', 'API', 'MCF', 'Pan-EU FBA', 'COGS', 'EOQ', 'ROP'])
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k] && !ACRONYMS.has(en[k]) && en[k].length > 5) {
    bad(`${k} translated`)
  }
}

console.log()
console.log(`[S.25 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
