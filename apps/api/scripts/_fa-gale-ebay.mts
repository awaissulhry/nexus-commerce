/* READ-ONLY: exact composition of GALE's collapsed "EBAY:IT" family */
const { default: prisma } = await import('../src/db.js')
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true } })
const kids = await prisma.product.findMany({ where: { parentId: gale!.id }, select: { id: true } })
// folded duplicate masters: childless masters whose eBay listing pools GALE's children
const dupMasters = await prisma.product.findMany({
  where: { parentId: null, sku: { contains: 'GALE' } },
  select: { id: true, sku: true },
})
const ids = [gale!.id, ...kids.map(k => k.id), ...dupMasters.map(d => d.id)]
const ls = await prisma.channelListing.findMany({
  where: { productId: { in: ids }, channel: 'EBAY', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { externalListingId: true, syncPaused: true, product: { select: { sku: true, parentId: true } } },
})
const byExt = new Map<string, string[]>()
for (const l of ls) {
  const a = byExt.get(l.externalListingId ?? '(none)') ?? []
  a.push(`${l.product?.sku}${l.product?.parentId ? '' : ' [MASTER]'}`)
  byExt.set(l.externalListingId ?? '(none)', a)
}
console.log('GALE group — EBAY:IT LISTING-lane rows, grouped by the eBay listing they really belong to:')
for (const [ext, skus] of byExt) console.log(`  itemId ${ext}: ${skus.length} rows -> ${skus.slice(0, 4).join(', ')}${skus.length > 4 ? ' …' : ''}`)
console.log('TOTAL rows in the single family key "EBAY:IT":', ls.length)
await prisma.$disconnect()
