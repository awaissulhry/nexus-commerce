import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// eBay LISTING-lane rows (as computeRows would emit) grouped by channel:marketplace
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, channel: 'EBAY' },
  select: {
    id: true, productId: true, channel: true, marketplace: true, externalListingId: true,
    quantity: true, syncPaused: true, followMasterQuantity: true,
    product: { select: { sku: true, parentId: true, parent: { select: { sku: true } } } },
  },
})
console.log('EBAY LISTING-lane rows total:', listings.length)
const byMkt = new Map<string, typeof listings>()
for (const l of listings) {
  const k = `EBAY:${l.marketplace}`
  const a = byMkt.get(k) ?? []
  a.push(l); byMkt.set(k, a)
}
for (const [k, arr] of byMkt) {
  const ids = new Map<string, number>()
  for (const l of arr) {
    const key = l.externalListingId ?? '(null)'
    ids.set(key, (ids.get(key) ?? 0) + 1)
  }
  console.log(`\n${k}: ${arr.length} rows, ${ids.size} distinct externalListingId`)
  for (const [id, n] of [...ids].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const sample = arr.filter((x) => (x.externalListingId ?? '(null)') === id).slice(0, 3)
      .map((x) => `${x.product?.sku}${x.product?.parentId ? '' : ' [MASTER]'}`)
    console.log(`   ${id}: ${n}  e.g. ${sample.join(', ')}`)
  }
}

// SHARED rows for the same markets
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { itemId: true, marketplace: true, sku: true, productId: true },
})
console.log('\nSHARED rows total:', mems.length, 'distinct itemIds:', new Set(mems.map(m => m.itemId)).size)
await prisma.$disconnect()
