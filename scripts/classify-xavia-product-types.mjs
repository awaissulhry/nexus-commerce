/**
 * One-time: classify Xavia product types from Italian product names.
 *
 * All 283 products currently have productType=null. This script infers the
 * type from keywords in the Italian product name and updates Product.productType.
 *
 * productType values match Amazon SP-API product type codes where possible
 * so the same field powers both Amazon listing updates and eBay category lookup.
 *
 * Rules (Italian keywords → productType):
 *   Giacca / Giubbotto → MOTORCYCLE_JACKET
 *   Guanti             → MOTORCYCLE_GLOVES
 *   Stivali / Scarpe   → MOTORCYCLE_BOOTS
 *   Casco / Helmet     → MOTORCYCLE_HELMET
 *   Pantaloni / Pant   → MOTORCYCLE_PANTS
 *   Tuta / Suit        → MOTORCYCLE_SUIT
 *   Gilet / Vest       → MOTORCYCLE_VEST
 *   Paraosseo / Schien → MOTORCYCLE_ARMOR
 *   (else)             → MOTORCYCLE_ACCESSORY
 *
 * Usage:
 *   node scripts/classify-xavia-product-types.mjs [--dry-run]
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const DRY_RUN = process.argv.includes('--dry-run')
const url = process.env.DATABASE_URL?.replace(/-pooler\./, '.')
const c = new pg.Client({ connectionString: url })
await c.connect()

// Fetch all products that still need classification
const { rows: products } = await c.query(`
  SELECT id, sku, name FROM "Product"
  WHERE "productType" IS NULL OR "productType" = ''
  ORDER BY name
`)

console.log(`Found ${products.length} products to classify${DRY_RUN ? ' (DRY RUN)' : ''}`)

function classify(name) {
  const n = name.toLowerCase()
  if (/giacca|giubbotto/i.test(n)) return 'MOTORCYCLE_JACKET'
  if (/guanti/i.test(n)) return 'MOTORCYCLE_GLOVES'
  if (/stivali|scarpe\s*moto/i.test(n)) return 'MOTORCYCLE_BOOTS'
  if (/casco|helmet/i.test(n)) return 'MOTORCYCLE_HELMET'
  if (/pantaloni|pant[^a]/i.test(n)) return 'MOTORCYCLE_PANTS'
  if (/tuta\s*(moto|da\s*moto|intera)|suit/i.test(n)) return 'MOTORCYCLE_SUIT'
  if (/gilet|vest\b/i.test(n)) return 'MOTORCYCLE_VEST'
  if (/paraosseo|schiena|armor|protezion/i.test(n)) return 'MOTORCYCLE_ARMOR'
  return 'MOTORCYCLE_ACCESSORY'
}

const byType = {}
const updates = []

for (const p of products) {
  const type = classify(p.name)
  byType[type] = (byType[type] ?? 0) + 1
  updates.push({ id: p.id, sku: p.sku, name: p.name.slice(0, 60), type })
}

console.log('\nClassification breakdown:')
console.table(Object.entries(byType).sort((a,b) => b[1]-a[1]).map(([t,c]) => ({ type: t, count: c })))

if (!DRY_RUN) {
  let updated = 0
  for (const u of updates) {
    await c.query(`UPDATE "Product" SET "productType" = $1, "updatedAt" = NOW() WHERE id = $2`, [u.type, u.id])
    updated++
  }
  console.log(`\nUpdated ${updated} products.`)
} else {
  console.log('\nSample (first 10):')
  console.table(updates.slice(0, 10).map(u => ({ sku: u.sku.slice(0,20), type: u.type, name: u.name })))
  console.log('\nRe-run without --dry-run to apply.')
}

await c.end()
