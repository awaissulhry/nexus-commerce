#!/usr/bin/env node
/**
 * S.21 verification — bulk transfer + bulk CSV import.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8') + '\n' + fs.readFileSync(path.join(here, '..', 'apps/web/src/components/inventory/StockSubNav.tsx'), 'utf8')
const importPagePath = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/import/page.tsx')
const importClientPath = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/import/ImportClient.tsx')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Backend endpoints registered
if (/fastify\.post\('\/stock\/bulk-transfer'/.test(stockRoutes)) ok('POST /api/stock/bulk-transfer registered')
else bad('POST /api/stock/bulk-transfer registered')
if (/fastify\.post\('\/stock\/bulk-import'/.test(stockRoutes)) ok('POST /api/stock/bulk-import registered')
else bad('POST /api/stock/bulk-import registered')

// 2. bulk-transfer iterates per-item, calls transferStock
if (/for \(const it of body\.items\)/.test(stockRoutes) && /transferStock\(\{/.test(stockRoutes)) {
  ok('bulk-transfer loops items + delegates to transferStock')
} else {
  bad('bulk-transfer loops items + delegates to transferStock')
}
if (/from === to/.test(stockRoutes)) ok('bulk-transfer guards from === to')
else bad('bulk-transfer guards from === to')

// 3. bulk-import dryRun + commit + 5000 cap + would-go-negative guard
if (/dryRun = !!body\.dryRun/.test(stockRoutes)) ok('bulk-import respects dryRun flag')
else bad('bulk-import respects dryRun flag')
if (/items capped at 5000/.test(stockRoutes)) ok('bulk-import caps at 5000 rows')
else bad('bulk-import caps at 5000 rows')
if (/would drive totalStock negative/.test(stockRoutes)) ok('bulk-import guards negative totalStock')
else bad('bulk-import guards negative totalStock')
if (/referenceType:\s*'BulkImport',?/.test(stockRoutes)) ok('bulk-import tags audit rows referenceType=BulkImport')
else bad('bulk-import tags audit rows referenceType=BulkImport')

// 4. Frontend BulkActionBar gains Transfer + modal
if (/onTransfer:/.test(stockWorkspace) && /labels\.transfer/.test(stockWorkspace)) {
  ok('BulkActionBar accepts onTransfer + label')
} else {
  bad('BulkActionBar accepts onTransfer + label')
}
if (/function BulkTransferModal/.test(stockWorkspace)) ok('BulkTransferModal component defined')
else bad('BulkTransferModal component defined')
if (/runBulkTransfer = useCallback/.test(stockWorkspace)) ok('runBulkTransfer callback')
else bad('runBulkTransfer callback')
if (/api\/stock\/bulk-transfer/.test(stockWorkspace)) ok('runBulkTransfer posts to /api/stock/bulk-transfer')
else bad('runBulkTransfer posts to /api/stock/bulk-transfer')

// 5. Import sub-route exists
if (fs.existsSync(importPagePath)) ok('import/page.tsx exists')
else bad('import/page.tsx exists')
if (fs.existsSync(importClientPath)) ok('import/ImportClient.tsx exists')
else bad('import/ImportClient.tsx exists')

const importClient = fs.readFileSync(importClientPath, 'utf8')
if (/parseCsv/.test(importClient)) ok('ImportClient has CSV parser')
else bad('ImportClient has CSV parser')
if (/dryRun: true/.test(importClient) && /dryRun: false/.test(importClient)) {
  ok('ImportClient supports preview (dry-run) + commit')
} else {
  bad('ImportClient supports preview (dry-run) + commit')
}
if (/CSV_TEMPLATE/.test(importClient) && /downloadTemplate/.test(importClient)) {
  ok('ImportClient ships a download-template button')
} else {
  bad('ImportClient ships a download-template button')
}
if (/file\.size > 2_000_000/.test(importClient)) ok('ImportClient caps file size at 2MB')
else bad('ImportClient caps file size at 2MB')

// 6. Workspace links to /import
if (/\/fulfillment\/stock\/import/.test(stockWorkspace)) ok('Workspace header links to /import')
else bad('Workspace header links to /import')

// 7. Catalog parity for new keys
const newKeys = [
  'stock.bulk.transfer', 'stock.bulk.transferTitle',
  'stock.bulk.transferDest', 'stock.bulk.transferHelp',
  'stock.bulk.transferApply',
  'stock.import.title', 'stock.import.description',
  'stock.import.template', 'stock.import.uploadLabel',
  'stock.import.location', 'stock.import.dryRun', 'stock.import.commit',
  'stock.import.colSku', 'stock.import.colChange',
  'stock.import.summarySucceeded', 'stock.import.summaryFailed',
  'stock.import.appliedToast',
]
const ACRONYMS = new Set(['COGS', 'FBA', 'SKU', 'API', 'EOQ', 'ROP', 'WAC', 'FIFO', 'LIFO', 'Formula', 'CSV'])
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
console.log(`[S.21 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
