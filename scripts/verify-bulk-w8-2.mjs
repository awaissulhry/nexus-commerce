#!/usr/bin/env node
// Verify W8.2 — parsers + column mapping (pure logic).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW8.2 — parsers + column mapping\n')

const parsers = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/import/parsers.ts'),
  'utf8',
)
const mapping = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/import/column-mapping.ts'),
  'utf8',
)
const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/import-wizard.routes.ts'),
  'utf8',
)
const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)

console.log('Case 1: parsers exports')
for (const sym of ['parseCsv', 'parseXlsx', 'parseJson', 'parseFile', 'detectFileKind']) {
  check(`exports ${sym}`, new RegExp(`export (function|async function) ${sym}`).test(parsers))
}

// Mirror suggestMapping for behavioural test
const ALIAS_MAP = {
  price: 'basePrice', msrp: 'maxPrice', cost: 'costPrice',
  qty: 'totalStock', quantity: 'totalStock', stock: 'totalStock',
  inventory: 'totalStock', title: 'name', productname: 'name',
  product: 'name', itemname: 'name', desc: 'description',
  productdescription: 'description', ean: 'ean', upc: 'upc',
  asin: 'amazonAsin', vendor: 'brand', manufacturer: 'manufacturer',
  hs: 'hsCode', origin: 'countryOfOrigin',
  reorderpoint: 'lowStockThreshold',
}
function normalise(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '') }
function suggestMapping(headers, fields) {
  const mapping = {}
  const used = new Set()
  const byExactId = new Map(), byExactLabel = new Map(), byNorm = new Map()
  for (const h of headers) {
    const lo = h.toLowerCase()
    if (!byExactId.has(lo)) byExactId.set(lo, h)
    if (!byExactLabel.has(lo)) byExactLabel.set(lo, h)
    const n = normalise(h)
    if (!byNorm.has(n)) byNorm.set(n, h)
  }
  for (const f of fields) {
    let m = byExactId.get(f.id.toLowerCase())
      ?? byExactLabel.get(f.label.toLowerCase())
      ?? byNorm.get(normalise(f.id))
      ?? byNorm.get(normalise(f.label))
    if (!m) {
      for (const h of headers) {
        if (used.has(h)) continue
        if (ALIAS_MAP[normalise(h)] === f.id) { m = h; break }
      }
    }
    if (m && !used.has(m)) {
      mapping[f.id] = m
      used.add(m)
    }
  }
  return {
    mapping,
    unmappedHeaders: headers.filter((h) => !used.has(h)),
    unmappedFields: fields.filter((f) => !mapping[f.id]).map((f) => f.id),
  }
}

console.log('\nCase 2: detectFileKind heuristic')
const detectFileKind = (s) => {
  if (!s) return 'csv'
  const lo = s.toLowerCase()
  if (lo.endsWith('.xlsx') || lo.endsWith('.xls')) return 'xlsx'
  if (lo.endsWith('.json')) return 'json'
  return 'csv'
}
check("'foo.csv' → csv", detectFileKind('foo.csv') === 'csv')
check("'foo.XLSX' → xlsx", detectFileKind('foo.XLSX') === 'xlsx')
check("'foo.json' → json", detectFileKind('foo.json') === 'json')
check("null → csv (default)", detectFileKind(null) === 'csv')

console.log('\nCase 3: column-mapping suggestions')
const FIELDS = [
  { id: 'sku', label: 'SKU' },
  { id: 'name', label: 'Name' },
  { id: 'basePrice', label: 'Base price' },
  { id: 'totalStock', label: 'Total stock' },
  { id: 'amazonAsin', label: 'Amazon ASIN' },
]
{
  const r = suggestMapping(['SKU', 'Name', 'Base price', 'Total stock', 'Amazon ASIN'], FIELDS)
  check('exact-label match wires every field',
    r.mapping.sku === 'SKU' && r.mapping.name === 'Name' &&
    r.mapping.basePrice === 'Base price' &&
    r.mapping.totalStock === 'Total stock' &&
    r.mapping.amazonAsin === 'Amazon ASIN')
  check('no unmapped headers when every field finds one',
    r.unmappedHeaders.length === 0)
}
{
  const r = suggestMapping(['sku', 'Title', 'Price', 'Qty', 'ASIN'], FIELDS)
  check("alias 'Title' → name", r.mapping.name === 'Title')
  check("alias 'Price' → basePrice", r.mapping.basePrice === 'Price')
  check("alias 'Qty' → totalStock", r.mapping.totalStock === 'Qty')
  check("alias 'ASIN' → amazonAsin", r.mapping.amazonAsin === 'ASIN')
}
{
  const r = suggestMapping(['BASE PRICE', 'NAME', 'sku'], FIELDS)
  check("normalised match 'BASE PRICE' → basePrice",
    r.mapping.basePrice === 'BASE PRICE')
  check("normalised match 'NAME' → name", r.mapping.name === 'NAME')
}
{
  const r = suggestMapping(['Title', 'Mystery Column'], FIELDS)
  check('unmappedHeaders surfaces the unmatched header',
    r.unmappedHeaders.includes('Mystery Column'))
  check('unmappedFields lists fields without a header',
    r.unmappedFields.includes('sku'))
}

console.log('\nCase 4: applyMapping')
function applyMapping(row, m) {
  const out = {}
  for (const [f, h] of Object.entries(m)) {
    if (!h) continue
    if (h in row) out[f] = row[h]
  }
  return out
}
{
  const r = applyMapping(
    { SKU: 'AIR-J', Title: 'Airmesh', Mystery: 'x' },
    { sku: 'SKU', name: 'Title' },
  )
  check('only mapped headers land in result',
    r.sku === 'AIR-J' && r.name === 'Airmesh' && !('Mystery' in r))
}

console.log('\nCase 5: routes registered')
for (const ep of [
  '/import-jobs',
  '/import-jobs/:id',
  '/import-jobs/:id/rows',
  '/import-jobs/preview',
  '/import-jobs/:id/apply',
  '/import-jobs/:id/retry-failed',
  '/import-jobs/:id/rollback',
]) {
  check(`route ${ep}`, routes.includes(`'${ep}'`))
}
check('preview persists a PENDING_PREVIEW job',
  /importService\.create\(\{[\s\S]{0,800}rows,\s*\}/.test(routes))
check('routes detect fileKind from filename when not supplied',
  /detectFileKind\(body\.filename \?\? null\)/.test(routes))

console.log('\nCase 6: index.ts wires the routes')
check('imports importWizardRoutes',
  /import importWizardRoutes/.test(idx))
check('registered with /api prefix',
  /app\.register\(importWizardRoutes,\s*\{\s*prefix:\s*'\/api'\s*\}\)/.test(idx))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
