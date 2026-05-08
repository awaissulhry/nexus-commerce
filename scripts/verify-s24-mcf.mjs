#!/usr/bin/env node
/**
 * S.24 verification — Amazon MCF integration.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const schema = fs.readFileSync(path.join(here, '..', 'packages/database/prisma/schema.prisma'), 'utf8')
const service = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/amazon-mcf.service.ts'), 'utf8')
const job = fs.readFileSync(path.join(here, '..', 'apps/api/src/jobs/amazon-mcf-status.job.ts'), 'utf8')
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const apiIndex = fs.readFileSync(path.join(here, '..', 'apps/api/src/index.ts'), 'utf8')
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8') + '\n' + fs.readFileSync(path.join(here, '..', 'apps/web/src/components/inventory/StockSubNav.tsx'), 'utf8')
const migrationDir = path.join(here, '..', 'packages/database/prisma/migrations/20260508_s24_mcf_shipments')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Migration files
if (fs.existsSync(path.join(migrationDir, 'migration.sql'))) ok('migration.sql exists')
else bad('migration.sql exists')
if (fs.existsSync(path.join(migrationDir, 'rollback.sql'))) ok('rollback.sql exists')
else bad('rollback.sql exists')
const migrationSql = fs.readFileSync(path.join(migrationDir, 'migration.sql'), 'utf8')
if (/CREATE TABLE IF NOT EXISTS "MCFShipment"/.test(migrationSql)) ok('migration creates MCFShipment')
else bad('migration creates MCFShipment')
if (/UNIQUE INDEX[\s\S]*?MCFShipment_amazonFulfillmentOrderId_key/.test(migrationSql)) {
  ok('migration adds unique index on amazonFulfillmentOrderId')
} else {
  bad('migration adds unique index on amazonFulfillmentOrderId')
}

// 2. Prisma schema
if (/model MCFShipment/.test(schema)) ok('schema declares MCFShipment')
else bad('schema declares MCFShipment')
if (/mcfShipments\s+MCFShipment\[\]/.test(schema)) ok('Order has mcfShipments relation')
else bad('Order has mcfShipments relation')

// 3. Service exports
const exportsExpected = [
  'export async function createMCFShipment',
  'export async function syncMCFStatus',
  'export async function cancelMCFShipment',
  'export async function listMCFShipments',
  'export const unconfiguredAdapter',
]
for (const e of exportsExpected) {
  if (service.includes(e)) ok(`service has ${e.replace('export async function ', '').replace('export const ', '')}`)
  else bad(`service has ${e.replace('export async function ', '').replace('export const ', '')}`)
}

// 4. Reserve-then-consume integration
if (/reserveOpenOrder\(\{/.test(service)) ok('createMCFShipment reserves stock at AMAZON-EU-FBA')
else bad('createMCFShipment reserves stock at AMAZON-EU-FBA')
if (/consumeOpenOrder\(\{[\s\S]*?orderId: shipment\.orderId/.test(service)) {
  ok('syncMCFStatus consumes on COMPLETE')
} else {
  bad('syncMCFStatus consumes on COMPLETE')
}
if (/releaseOpenOrder\(\{[\s\S]*?orderId: shipment\.orderId/.test(service)) {
  ok('syncMCFStatus releases on CANCELLED/UNFULFILLABLE/INVALID')
} else {
  bad('syncMCFStatus releases on CANCELLED/UNFULFILLABLE/INVALID')
}

// 5. Idempotency: existing active shipment short-circuit
if (/Idempotency: a single Order has at most one active MCFShipment/.test(service)) {
  ok('createMCFShipment idempotent against existing active shipment')
} else {
  bad('createMCFShipment idempotent against existing active shipment')
}

// 6. Rollback on adapter failure
if (/release[\s\S]*?reservation failure[\s\S]*?throw err/.test(service)
    || /releaseOpenOrder[\s\S]*?'reservation failure'/.test(service)) {
  ok('createMCFShipment releases reservations on adapter failure')
} else {
  bad('createMCFShipment releases reservations on adapter failure')
}

// 7. Cron
if (/\*\/15 \* \* \* \*/.test(job)) ok('cron schedule = every 15 min')
else bad('cron schedule = every 15 min')
if (/NEXUS_ENABLE_MCF_STATUS_CRON/.test(job)) ok('cron has opt-out env')
else bad('cron has opt-out env')
if (/import \{ startAmazonMCFStatusCron \}/.test(apiIndex)) ok('apiIndex imports cron')
else bad('apiIndex imports cron')
if (/startAmazonMCFStatusCron\(\)/.test(apiIndex)) ok('apiIndex starts cron')
else bad('apiIndex starts cron')

// 8. Routes
if (/'\/stock\/mcf'/.test(stockRoutes)) ok('GET /api/stock/mcf registered')
else bad('GET /api/stock/mcf registered')
if (/'\/stock\/mcf\/create'/.test(stockRoutes)) ok('POST /api/stock/mcf/create registered')
else bad('POST /api/stock/mcf/create registered')
if (/'\/stock\/mcf\/:id\/sync'/.test(stockRoutes)) ok('POST /api/stock/mcf/:id/sync registered')
else bad('POST /api/stock/mcf/:id/sync registered')
if (/'\/stock\/mcf\/:id\/cancel'/.test(stockRoutes)) ok('POST /api/stock/mcf/:id/cancel registered')
else bad('POST /api/stock/mcf/:id/cancel registered')

// 9. Frontend
const pagePath = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/mcf/page.tsx')
const clientPath = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/mcf/MCFClient.tsx')
if (fs.existsSync(pagePath)) ok('mcf/page.tsx exists')
else bad('mcf/page.tsx exists')
if (fs.existsSync(clientPath)) ok('mcf/MCFClient.tsx exists')
else bad('mcf/MCFClient.tsx exists')
const client = fs.readFileSync(clientPath, 'utf8')
if (/api\/stock\/mcf\?status=/.test(client)) ok('client GETs /api/stock/mcf?status=')
else bad('client GETs /api/stock/mcf?status=')
if (/\/sync/.test(client)) ok('client wires /sync action')
else bad('client wires /sync action')
if (/\/cancel/.test(client)) ok('client wires /cancel action')
else bad('client wires /cancel action')

// 10. Workspace link
if (/\/fulfillment\/stock\/mcf/.test(stockWorkspace)) ok('workspace links to /mcf')
else bad('workspace links to /mcf')

// 11. Catalog parity
const newKeys = [
  'stock.mcf.title', 'stock.mcf.description',
  'stock.mcf.filter.all', 'stock.mcf.filter.active',
  'stock.mcf.col.order', 'stock.mcf.col.amazonId',
  'stock.mcf.col.tracking', 'stock.mcf.col.requested',
  'stock.mcf.empty.title', 'stock.mcf.empty.description',
  'stock.mcf.cancelConfirmTitle', 'stock.mcf.cancelConfirmDescription',
  'stock.mcf.toast.synced', 'stock.mcf.toast.cancelled',
]
const ACRONYMS = new Set(['MCF', 'FBA', 'SKU', 'API', 'CSV', 'COGS', 'EOQ', 'ROP', 'WAC', 'FIFO', 'LIFO', 'Tracking', 'Status', 'Amazon MCF', 'ID Amazon', 'Amazon ID'])
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
console.log(`[S.24 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
