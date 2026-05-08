#!/usr/bin/env node
/**
 * S.20 verification — costing methodology (FIFO/LIFO/WAC + landed cost).
 * Pure file-content + schema + migration checks (live DB applies via
 * prisma migrate deploy on Railway).
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const schema = fs.readFileSync(path.join(here, '..', 'packages/database/prisma/schema.prisma'), 'utf8')
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const stockMovementService = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/stock-movement.service.ts'), 'utf8')
const costLayersService = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/cost-layers.service.ts'), 'utf8')
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8')
const migrationDir = path.join(here, '..', 'packages/database/prisma/migrations/20260508_s20_cost_layers')

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
if (/CREATE TABLE IF NOT EXISTS "StockCostLayer"/.test(migrationSql)) ok('migration creates StockCostLayer')
else bad('migration creates StockCostLayer')
if (/ADD COLUMN IF NOT EXISTS "costingMethod" TEXT NOT NULL DEFAULT 'WAC'/.test(migrationSql)) {
  ok('Product.costingMethod default WAC')
} else {
  bad('Product.costingMethod default WAC')
}
if (/ADD COLUMN IF NOT EXISTS "weightedAvgCostCents" INTEGER/.test(migrationSql)) {
  ok('Product.weightedAvgCostCents column')
} else {
  bad('Product.weightedAvgCostCents column')
}
if (/ALTER TABLE "StockMovement"[\s\S]*?ADD COLUMN IF NOT EXISTS "cogsCents" INTEGER/.test(migrationSql)) {
  ok('StockMovement.cogsCents column')
} else {
  bad('StockMovement.cogsCents column')
}
if (/INSERT INTO "StockCostLayer"[\s\S]*?S\.20 backfill/.test(migrationSql)) {
  ok('synthetic seed backfill present')
} else {
  bad('synthetic seed backfill present')
}

// 2. Prisma schema
if (/model StockCostLayer/.test(schema)) ok('schema defines StockCostLayer')
else bad('schema defines StockCostLayer')
if (/costingMethod\s+String\s+@default\("WAC"\)/.test(schema)) ok('schema costingMethod default WAC')
else bad('schema costingMethod default WAC')
if (/weightedAvgCostCents\s+Int\?/.test(schema)) ok('schema weightedAvgCostCents Int?')
else bad('schema weightedAvgCostCents Int?')
if (/cogsCents\s+Int\?/.test(schema)) ok('schema StockMovement.cogsCents Int?')
else bad('schema StockMovement.cogsCents Int?')

// 3. Service exports + tx-aware variants
const exportsExpected = [
  'export async function receiveLayer',
  'export async function receiveLayerInTx',
  'export async function consumeLayers',
  'export async function consumeLayersInTx',
  'export async function recomputeWac',
  'export async function getCurrentCost',
  'export async function listLayers',
]
for (const e of exportsExpected) {
  if (costLayersService.includes(e)) ok(`service has ${e.replace('export async function ', '')}`)
  else bad(`service has ${e.replace('export async function ', '')}`)
}

// 4. WAC weighted-average formula present
if (/totalUnits === 0 \? 0 : Math\.round\(weightedCents \/ totalUnits\)/.test(costLayersService)) {
  ok('WAC formula: weightedCents / totalUnits')
} else {
  bad('WAC formula: weightedCents / totalUnits')
}

// 5. FIFO/LIFO ordering
if (/method === 'FIFO' \? 'asc' : 'desc'/.test(costLayersService)) {
  ok('FIFO/LIFO order: ASC for FIFO, DESC for LIFO')
} else {
  bad('FIFO/LIFO order: ASC for FIFO, DESC for LIFO')
}

// 6. Hooks in stock-movement.service
if (/CONSUME_REASONS = new Set\(/.test(stockMovementService)) ok('CONSUME_REASONS set defined')
else bad('CONSUME_REASONS set defined')
if (/RECEIVE_AUTO_LAYER_REASONS = new Set\(/.test(stockMovementService)) ok('RECEIVE_AUTO_LAYER_REASONS set defined')
else bad('RECEIVE_AUTO_LAYER_REASONS set defined')
if (/consumeLayersInTx\(tx, \{ productId, units: -change \}\)/.test(stockMovementService)) {
  ok('applyStockMovement consumes layers on subtractive')
} else {
  bad('applyStockMovement consumes layers on subtractive')
}
if (/receiveLayerInTx\(tx, \{/.test(stockMovementService)) {
  ok('applyStockMovement creates layer on receive reasons')
} else {
  bad('applyStockMovement creates layer on receive reasons')
}
if (/cogsCents,/.test(stockMovementService)) ok('StockMovement.create persists cogsCents')
else bad('StockMovement.create persists cogsCents')

// 7. Routes
if (/'\/stock\/cost-layers\/:productId'/.test(stockRoutes)) ok('GET /api/stock/cost-layers/:id registered')
else bad('GET /api/stock/cost-layers/:id registered')
if (/'\/stock\/cost-layers\/:productId\/recompute-wac'/.test(stockRoutes)) {
  ok('POST /api/stock/cost-layers/:id/recompute-wac registered')
} else {
  bad('POST /api/stock/cost-layers/:id/recompute-wac registered')
}

// 8. Drawer bundle includes costing
if (/costing:\s*\{[\s\S]*?method:[\s\S]*?weightedAvgCostCents:[\s\S]*?layers:/.test(stockRoutes)) {
  ok('drawer bundle includes costing.method + WAC + layers')
} else {
  bad('drawer bundle includes costing.method + WAC + layers')
}

// 9. Frontend cost-layers section
if (/stock\.costLayers\.section/.test(stockWorkspace)) ok('drawer renders cost-layers section')
else bad('drawer renders cost-layers section')

// 10. Catalog parity
const newKeys = [
  'stock.costLayers.section',
  'stock.costLayers.method.WAC',
  'stock.costLayers.method.FIFO',
  'stock.costLayers.method.LIFO',
  'stock.costLayers.currentWac',
  'stock.costLayers.col.received',
  'stock.costLayers.col.unitCost',
  'stock.costLayers.col.units',
  'stock.costLayers.col.source',
  'stock.costLayers.empty',
  'stock.costLayers.seedNote',
]
const ACRONYMS = new Set(['COGS', 'FBA', 'SKU', 'API', 'EOQ', 'ROP', 'WAC', 'FIFO', 'LIFO', 'Formula'])
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k] && !ACRONYMS.has(en[k]) && !en[k].startsWith('FIFO') && !en[k].startsWith('LIFO')) {
    bad(`${k} translated`)
  }
}

console.log()
console.log(`[S.20 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
