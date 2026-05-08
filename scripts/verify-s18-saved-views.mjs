#!/usr/bin/env node
/**
 * S.18 verification — saved views on the stock workspace.
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

// Type + persistence helpers
if (/type SavedView = \{/.test(stock)) ok('SavedView type defined')
else bad('SavedView type defined')

if (/SAVED_VIEWS_STORAGE_KEY = 'stock\.savedViews'/.test(stock)) ok('localStorage key set')
else bad('localStorage key set')

if (/function readSavedViews/.test(stock) && /function writeSavedViews/.test(stock)) {
  ok('read/write helpers present')
} else {
  bad('read/write helpers present')
}

// State + handlers
if (/setSavedViews\(readSavedViews\(\)\)/.test(stock)) ok('state hydrates from localStorage on mount')
else bad('state hydrates from localStorage on mount')

if (/applySavedView = useCallback/.test(stock)) ok('applySavedView callback')
else bad('applySavedView callback')
if (/saveCurrentAsView = useCallback/.test(stock)) ok('saveCurrentAsView callback')
else bad('saveCurrentAsView callback')
if (/deleteSavedView = useCallback/.test(stock)) ok('deleteSavedView callback')
else bad('deleteSavedView callback')

// Apply restores filters via URL + density/columns via setters
if (/router\.replace\(/.test(stock) && /setDensity\(v\.density\)/.test(stock)
    && /setVisibleColumns\(v\.visibleColumns\)/.test(stock)) {
  ok('applySavedView writes URL + restores density + columns')
} else {
  bad('applySavedView writes URL + restores density + columns')
}

// UI components
if (/function SavedViewsButton/.test(stock)) ok('SavedViewsButton component defined')
else bad('SavedViewsButton component defined')
if (/<SavedViewsButton/.test(stock)) ok('SavedViewsButton rendered')
else bad('SavedViewsButton rendered')

// Save modal
if (/saveViewModalOpen/.test(stock) && /<Modal title=\{t\('stock\.savedViews\.saveTitle'\)/.test(stock)) {
  ok('save modal rendered')
} else {
  bad('save modal rendered')
}

// Catalog parity
const newKeys = [
  'stock.savedViews.title', 'stock.savedViews.empty',
  'stock.savedViews.saveCurrent', 'stock.savedViews.delete',
  'stock.savedViews.saveTitle', 'stock.savedViews.nameLabel',
  'stock.savedViews.namePlaceholder', 'stock.savedViews.save',
]
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k]) bad(`${k} translated`)
}

console.log()
console.log(`[S.18 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
