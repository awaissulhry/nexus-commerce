const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, channel: 'EBAY' },
  select: { marketplace: true, product: { select: { sku: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, marketplace: true, itemId: true },
})
const lset = new Set(listings.map((l) => `${l.product?.sku}|${l.marketplace}`))
const byKey = new Map<string, string[]>()
for (const m of mems) {
  const k = `${m.sku}|${m.marketplace}`
  byKey.set(k, [...(byKey.get(k) ?? []), m.itemId])
}
let overlap = 0
let multi = 0
const samples: string[] = []
for (const [k, ids] of byKey) {
  if (lset.has(k)) {
    overlap++
    if (samples.length < 8) samples.push(`${k} -> ${ids.length} memberships [${ids.slice(0, 6).join(',')}]`)
  }
  if (ids.length > 1) multi++
}
console.log('EBAY published listings:', listings.length, 'active memberships:', mems.length, 'membership (sku,mkt) groups:', byKey.size)
console.log('groups that ALSO have an eBay ChannelListing row:', overlap)
console.log('groups with >1 itemId:', multi)
console.log(samples.join('\n'))
await prisma.$disconnect()
