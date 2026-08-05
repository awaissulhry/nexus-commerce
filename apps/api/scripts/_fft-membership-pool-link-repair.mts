/** FFT-I2 — repair SharedListingMembership rows whose pool link (productId)
 *  was stripped: fill NULL productId by EXACT sku match to an alive product.
 *  The membership sku IS the pool child SKU by construction (relabel executed
 *  2026-07-18), so this is deterministic. Never overwrites a non-null link.
 *  Dry-run by default; --apply executes. Covers ALL families, not just GALE. */
const prisma = (await import('../src/db.js')).default
const APPLY = process.argv.includes('--apply')

const broken = await prisma.sharedListingMembership.findMany({
  where: { productId: null },
  select: { id: true, sku: true, itemId: true, parentSku: true, marketplace: true, status: true },
})
console.log(`memberships with NULL productId: ${broken.length}`)
const skus = [...new Set(broken.map((m) => m.sku).filter(Boolean))]
const products = skus.length
  ? await prisma.product.findMany({ where: { sku: { in: skus }, deletedAt: null }, select: { id: true, sku: true } })
  : []
const bySku = new Map(products.map((p) => [p.sku, p.id]))

let fixable = 0
const byListing = new Map<string, { fixed: number; unfixable: number; parentSku: string }>()
for (const m of broken) {
  const e = byListing.get(m.itemId) ?? { fixed: 0, unfixable: 0, parentSku: m.parentSku ?? '?' }
  if (m.sku && bySku.has(m.sku)) { e.fixed++; fixable++ } else e.unfixable++
  byListing.set(m.itemId, e)
}
for (const [itemId, e] of byListing) console.log(`  ${itemId} (${e.parentSku}): fixable=${e.fixed} unfixable=${e.unfixable}`)

if (APPLY && fixable > 0) {
  let applied = 0
  for (const m of broken) {
    const pid = m.sku ? bySku.get(m.sku) : undefined
    if (!pid) continue
    await prisma.sharedListingMembership.update({ where: { id: m.id }, data: { productId: pid } })
    applied++
  }
  console.log(`APPLIED: relinked ${applied} memberships`)
} else {
  console.log(`dry-run — ${fixable} fixable (pass --apply)`)
}
await prisma.$disconnect()
process.exit(0)
