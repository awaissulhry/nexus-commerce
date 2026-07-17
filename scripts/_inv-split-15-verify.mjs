// _inv-split-15-verify.mjs — Phase 1.7 end-to-end verification (READ-ONLY).
// Proves, across the whole catalog, that every eBay (FBM) listing publishes
// warehouse-available − buffer and is independent of Amazon FBA stock.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const prisma = new PrismaClient()

const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', followMasterQuantity: true, quantity: { not: null } },
  select: {
    quantity: true, stockBuffer: true, marketplace: true,
    product: {
      select: {
        sku: true, totalStock: true,
        stockLevels: { select: { available: true, quantity: true, location: { select: { type: true } } } },
      },
    },
  },
})

let total = 0, correct = 0
const mismatches = []
let fbaPresent = 0, fbaIndependent = 0
for (const cl of cls) {
  const lv = cl.product.stockLevels
  const whAvail = lv.filter((s) => s.location?.type === 'WAREHOUSE').reduce((a, s) => a + s.available, 0)
  const whQty = lv.filter((s) => s.location?.type === 'WAREHOUSE').reduce((a, s) => a + s.quantity, 0)
  const fba = lv.filter((s) => s.location?.type === 'AMAZON_FBA').reduce((a, s) => a + s.quantity, 0)
  const buf = cl.stockBuffer ?? 0
  const expected = Math.max(0, whAvail - buf)
  const oldBuggy = Math.max(0, whQty + fba - buf) // what the pre-fix bleed would publish
  total++
  if (cl.quantity === expected) correct++
  else mismatches.push({ sku: cl.product.sku, mkt: cl.marketplace, qty: cl.quantity, expected, whAvail, whQty, fba, buf })
  if (fba > 0) {
    fbaPresent++
    // Provably independent: eBay qty matches warehouse-available AND that differs
    // from the FBA-inclusive number, so it can't be tracking FBA.
    if (cl.quantity === expected && expected !== oldBuggy) fbaIndependent++
  }
}

console.log('\nPhase 1.7 — split-inventory end-to-end verification (read-only)')
console.log(`eBay (FBM, followMaster) listings checked: ${total}`)
console.log(`  qty == warehouse-available − buffer (CORRECT): ${correct}`)
console.log(`  mismatches: ${mismatches.length}`)
console.log(`  listings whose product has FBA stock: ${fbaPresent}`)
console.log(`    of which PROVABLY FBA-independent (eBay tracks warehouse, ≠ wh+FBA): ${fbaIndependent}`)
if (mismatches.length) {
  console.log('\nMismatches:')
  console.log(JSON.stringify(mismatches.slice(0, 25), null, 2))
}
console.log(`\nVERDICT: ${mismatches.length === 0 ? '✓ every eBay listing tracks warehouse-available; FBA fully excluded' : '✗ ' + mismatches.length + ' listing(s) need review'}`)
await prisma.$disconnect()
