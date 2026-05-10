/**
 * Fix Product.productType to use valid Amazon SP-API product type codes.
 *
 * The previous classify script used made-up types (MOTORCYCLE_JACKET etc.)
 * that Amazon doesn't recognise. This remaps them to the real codes that
 * appear in BUNDLED_AMAZON_PRODUCT_TYPES:
 *
 *   MOTORCYCLE_JACKET    → OUTERWEAR
 *   MOTORCYCLE_GLOVES    → GLOVES
 *   MOTORCYCLE_BOOTS     → BOOT
 *   MOTORCYCLE_HELMET    → HELMET
 *   MOTORCYCLE_PANTS     → PANTS
 *   MOTORCYCLE_SUIT      → SUIT
 *   MOTORCYCLE_VEST      → OUTERWEAR   (closest: waistcoat/body warmer)
 *   MOTORCYCLE_ARMOR     → PROTECTIVE_GEAR
 *   MOTORCYCLE_ACCESSORY → AUTO_ACCESSORY
 *
 * Usage:  node scripts/fix-product-types-to-amazon.mjs [--dry-run]
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

const REMAP = {
  MOTORCYCLE_JACKET:    'OUTERWEAR',
  MOTORCYCLE_GLOVES:    'GLOVES',
  MOTORCYCLE_BOOTS:     'BOOT',
  MOTORCYCLE_HELMET:    'HELMET',
  MOTORCYCLE_PANTS:     'PANTS',
  MOTORCYCLE_SUIT:      'SUIT',
  MOTORCYCLE_VEST:      'OUTERWEAR',
  MOTORCYCLE_ARMOR:     'PROTECTIVE_GEAR',
  MOTORCYCLE_ACCESSORY: 'AUTO_ACCESSORY',
}

const { rows } = await c.query(
  `SELECT id, sku, name, "productType" FROM "Product" WHERE "productType" = ANY($1::text[])`,
  [Object.keys(REMAP)],
)

console.log(`Found ${rows.length} products to remap${DRY_RUN ? ' (DRY RUN)' : ''}\n`)

const byOld = {}
for (const r of rows) {
  byOld[r.productType] = (byOld[r.productType] ?? 0) + 1
}
console.table(
  Object.entries(byOld).map(([old, count]) => ({
    from: old,
    to: REMAP[old],
    count,
  })),
)

if (!DRY_RUN) {
  let updated = 0
  for (const [oldType, newType] of Object.entries(REMAP)) {
    const res = await c.query(
      `UPDATE "Product" SET "productType" = $1, "updatedAt" = NOW() WHERE "productType" = $2`,
      [newType, oldType],
    )
    if (res.rowCount > 0) {
      console.log(`  ${oldType} → ${newType}: ${res.rowCount} rows`)
      updated += res.rowCount
    }
  }
  console.log(`\nUpdated ${updated} products.`)
} else {
  console.log('\nRe-run without --dry-run to apply.')
}

await c.end()
