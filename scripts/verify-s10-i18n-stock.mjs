#!/usr/bin/env node
/**
 * S.10 verification — stock workspace wired through useTranslations,
 * stock.* keys present in both en/it catalogs, key parity holds, and
 * the highest-impact strings now route through t().
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const stock = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8') + '\n' + fs.readFileSync(path.join(here, '..', 'apps/web/src/components/inventory/StockSubNav.tsx'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. catalogs are valid JSON (proven by parse above)
ok('en.json valid JSON')
ok('it.json valid JSON')

// 2. stock.* keys exist in both catalogs
const stockKeysEn = Object.keys(en).filter((k) => k.startsWith('stock.'))
const stockKeysIt = Object.keys(it).filter((k) => k.startsWith('stock.'))
if (stockKeysEn.length >= 30) ok(`en.json has ${stockKeysEn.length} stock.* keys`)
else bad(`en.json has 30+ stock.* keys`, `${stockKeysEn.length}`)
if (stockKeysIt.length >= 30) ok(`it.json has ${stockKeysIt.length} stock.* keys`)
else bad(`it.json has 30+ stock.* keys`, `${stockKeysIt.length}`)

// 3. parity — every en.stock.* key has a matching it.stock.* key
const enSet = new Set(stockKeysEn)
const itSet = new Set(stockKeysIt)
const missingInIt = [...enSet].filter((k) => !itSet.has(k))
const extraInIt = [...itSet].filter((k) => !enSet.has(k))
if (missingInIt.length === 0) ok('every en stock key has an it translation')
else bad('every en stock key has an it translation', `missing in it: ${missingInIt.slice(0, 5).join(', ')}`)
if (extraInIt.length === 0) ok('no orphan it stock keys without en counterpart')
else bad('no orphan it stock keys', `extra in it: ${extraInIt.slice(0, 5).join(', ')}`)

// 4. Italian translations are non-empty and not equal to the English
//    (smoke check that someone actually translated). Acronyms,
//    brand names, and universal short tokens (ok / SKU / FBA / etc.)
//    legitimately stay identical between the two locales.
const ACRONYMS = /^(SKU|FBA|MCF|EOQ|ROP|WAC|FIFO|LIFO|COGS|ABC|ATP|DOH|RFID|CSV|UPC|EAN|GTIN|Pan-EU FBA|Amazon MCF|Formula|ok)$/i
let untranslated = 0
let identical = 0
const identicalKeys = []
for (const k of stockKeysEn) {
  const v = it[k]
  if (!v || v.trim() === '') untranslated++
  else if (v === en[k] && !ACRONYMS.test(en[k].trim())) {
    identical++
    identicalKeys.push(`${k}="${en[k]}"`)
  }
}
if (untranslated === 0) ok('every it stock key has a non-empty value')
else bad('every it stock key has a non-empty value', `${untranslated} empty`)
if (identical === 0) ok('stock translations differ from English (acronyms exempt)')
else bad('stock translations differ from English', `${identical} identical: ${identicalKeys.slice(0, 5).join(', ')}`)

// 5. useTranslations is imported and called in the workspace
if (/import\s*\{[^}]*\buseTranslations\b[^}]*\}\s*from\s*['"]@\/lib\/i18n\/use-translations['"]/.test(stock)) {
  ok('useTranslations imported in StockWorkspace')
} else {
  bad('useTranslations imported in StockWorkspace')
}
if (/const \{ t \} = useTranslations\(\)/.test(stock)) {
  ok('useTranslations destructured in component')
} else {
  bad('useTranslations destructured in component')
}

// 6. High-impact strings now route through t()
const required = [
  "t('stock.title')",
  "t('stock.description')",
  "t('stock.action.cycleCounts')",
  "t('stock.action.refresh')",
  "t('stock.filters.location')",
  "t('stock.filters.status')",
  "t('stock.filters.searchPlaceholder')",
  "t('stock.empty.title')",
  "t('stock.loading')",
  "t('stock.kpi.totalValue')",
  "t('stock.kpi.stockouts')",
  "t('stock.kpi.critical')",
  "t('stock.kpi.available')",
  "t('stock.bulk.adjust')",
  "t('stock.pagination.previous')",
  "t('stock.pagination.next')",
]
// Accept either a direct `t('key')` call OR the bare key as a
// labelKey string in an object literal (StockSubNav uses
// `labelKey: 'stock.action.cycleCounts'` and resolves via t() at
// render time — same behaviour, different shape on disk).
let missing = 0
for (const r of required) {
  const key = r.match(/^t\('([^']+)'\)$/)?.[1]
  const present = stock.includes(r) || (key && stock.includes(`'${key}'`))
  if (!present) {
    missing++
    bad(`StockWorkspace contains ${r}`)
  }
}
if (missing === 0) ok(`StockWorkspace wires all ${required.length} required t() calls`)

console.log()
console.log(`[S.10 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
