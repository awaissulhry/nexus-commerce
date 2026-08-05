const { default: prisma } = await import('../src/db.js')

// published eBay channel listings (LISTING lane rows)
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, marketplace: true, syncPaused: true, followMasterQuantity: true, product: { select: { sku: true, parentId: true } } },
})
console.log('EBAY LISTING-lane rows:', cls.length)
const byMarket: Record<string, number> = {}
for (const c of cls) byMarket[c.marketplace] = (byMarket[c.marketplace] ?? 0) + 1
console.log('by market:', byMarket)

const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { sku: true, productId: true, marketplace: true, itemId: true } })
console.log('ACTIVE memberships (SHARED rows):', mems.length)

// products that have BOTH an eBay LISTING row and a membership
const memPids = new Set(mems.map(m => m.productId).filter(Boolean) as string[])
const both = cls.filter(c => memPids.has(c.productId))
console.log('eBay listings whose product is ALSO pooled (both lanes present):', both.length)

// group by canonical master to see the "EBAY:IT" family (no itemId) size per product
const byMaster = new Map<string, number>()
for (const c of both) {
  const m = c.product?.parentId ?? c.productId
  byMaster.set(m, (byMaster.get(m) ?? 0) + 1)
}
const top = [...byMaster.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)
const names = await prisma.product.findMany({ where: { id: { in: top.map(t=>t[0]) } }, select: { id: true, sku: true, name: true } })
const nm = new Map(names.map(n=>[n.id, n.sku]))
console.log('top masters by count of eBay LISTING rows (itemId-less family EBAY:IT):')
for (const [id, n] of top) console.log('  ', nm.get(id), n)
await prisma.$disconnect()
