#!/usr/bin/env node
/**
 * S.12 verification — structured reason picker for stock adjustments.
 * Pure file-content check.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const stock = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. SUB_REASON_OPTIONS constant + 7 options (OTHER + 6 reasons)
if (/SUB_REASON_OPTIONS/.test(stock)) ok('SUB_REASON_OPTIONS constant defined')
else bad('SUB_REASON_OPTIONS constant defined')

const expectedSubReasons = ['OTHER', 'DAMAGE', 'THEFT', 'SCRAP', 'FOUND', 'RECOUNT', 'INITIAL_LOAD']
for (const r of expectedSubReasons) {
  const pattern = new RegExp(`value:\\s*'${r}'`)
  if (pattern.test(stock)) ok(`SUB_REASON_OPTIONS contains ${r}`)
  else bad(`SUB_REASON_OPTIONS contains ${r}`)
}

// 2. buildAdjustmentPayload helper exists
if (/function buildAdjustmentPayload/.test(stock)) ok('buildAdjustmentPayload helper defined')
else bad('buildAdjustmentPayload helper defined')

// 3. AdjustPanel uses the picker + helper
const adjustPanelMatch = stock.match(/function AdjustPanel[\s\S]*?\n\}/)
if (adjustPanelMatch && /SUB_REASON_OPTIONS\.map/.test(adjustPanelMatch[0])) {
  ok('AdjustPanel renders the sub-reason picker')
} else {
  bad('AdjustPanel renders the sub-reason picker')
}
if (adjustPanelMatch && /buildAdjustmentPayload/.test(adjustPanelMatch[0])) {
  ok('AdjustPanel routes through buildAdjustmentPayload')
} else {
  bad('AdjustPanel routes through buildAdjustmentPayload')
}

// 4. BulkAdjustModal uses the picker + signature
if (/onConfirm:\s*\(change:\s*number,\s*subReason:\s*AdjustSubReason,\s*notes/.test(stock)) {
  ok('BulkAdjustModal onConfirm signature includes subReason')
} else {
  bad('BulkAdjustModal onConfirm signature includes subReason')
}
// BulkAdjustModal contains JSX with nested braces; slice from its
// declaration to the next top-level function declaration.
const bulkStart = stock.indexOf('function BulkAdjustModal')
const nextFn = stock.indexOf('\nfunction ', bulkStart + 1)
const bulkModalSrc = bulkStart >= 0 ? stock.slice(bulkStart, nextFn > 0 ? nextFn : undefined) : ''
if (bulkModalSrc && /SUB_REASON_OPTIONS\.map/.test(bulkModalSrc)) {
  ok('BulkAdjustModal renders the sub-reason picker')
} else {
  bad('BulkAdjustModal renders the sub-reason picker')
}

// 5. runBulkAdjust threads subReason
if (/runBulkAdjust = useCallback\(async \(change:\s*number,\s*subReason:\s*AdjustSubReason/.test(stock)) {
  ok('runBulkAdjust signature includes subReason')
} else {
  bad('runBulkAdjust signature includes subReason')
}

// 6. Catalog keys for sub-reasons
const subReasonKeys = ['stock.subReason.other', 'stock.subReason.damage', 'stock.subReason.theft',
  'stock.subReason.scrap', 'stock.subReason.found', 'stock.subReason.recount', 'stock.subReason.initialLoad']
for (const k of subReasonKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k]) bad(`${k} translated (en !== it)`)
}

// 7. Helper output: structured prefix on non-OTHER, null on OTHER+empty
//    (smoke check via regex on the helper body)
const helperBody = stock.match(/function buildAdjustmentPayload[\s\S]*?\n\}/)?.[0]
if (helperBody && /\[\$\{subReason\}\]/.test(helperBody)) {
  ok('buildAdjustmentPayload prefixes notes with [SUB_REASON]')
} else {
  bad('buildAdjustmentPayload prefixes notes with [SUB_REASON]')
}
if (helperBody && /reason: opt\.schemaReason/.test(helperBody)) {
  ok('buildAdjustmentPayload returns schema-level reason')
} else {
  bad('buildAdjustmentPayload returns schema-level reason')
}

console.log()
console.log(`[S.12 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
