/* READ-ONLY probe: family scoping integrity (DIM 2) */
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: {
    id: true, productId: true, channel: true, marketplace: true, externalListingId: true,
    product: { select: { sku: true, parentId: true } },
  },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true },
})

console.log('=== A. marketplace token shapes ===')
const lm = new Map<string, number>()
for (const l of listings) lm.set(`${l.channel}|${l.marketplace}`, (lm.get(`${l.channel}|${l.marketplace}`) ?? 0) + 1)
console.log('LISTING channel|marketplace:', [...lm.entries()].sort())
const mm = new Map<string, number>()
for (const m of mems) mm.set(m.marketplace, (mm.get(m.marketplace) ?? 0) + 1)
console.log('SHARED marketplace:', [...mm.entries()].sort())

console.log('\n=== B. >1 published ChannelListing on same (productId,channel,marketplace) ===')
const byPCM = new Map<string, typeof listings>()
for (const l of listings) {
  const k = `${l.productId}|${l.channel}|${l.marketplace}`
  const a = byPCM.get(k) ?? []
  a.push(l); byPCM.set(k, a)
}
let dupPCM = 0
for (const [k, arr] of byPCM) {
  if (arr.length > 1) {
    dupPCM++
    if (dupPCM <= 15) console.log(' DUP', arr[0].product?.sku, k.split('|').slice(1).join(':'), 'n=', arr.length, 'itemIds=', arr.map(a => a.externalListingId))
  }
}
console.log('total (productId,channel,marketplace) groups with >1 published listing:', dupPCM)

console.log('\n=== C. externalListingId shared by >1 ChannelListing (ownerSku determinism) ===')
const byExt = new Map<string, typeof listings>()
for (const l of listings) {
  if (!l.externalListingId) continue
  const a = byExt.get(l.externalListingId) ?? []
  a.push(l); byExt.set(l.externalListingId, a)
}
let dupExt = 0
for (const [ext, arr] of byExt) {
  if (arr.length > 1) {
    dupExt++
    if (dupExt <= 20) console.log(' EXT', ext, 'n=', arr.length, 'skus=', arr.map(a => a.product?.sku), 'hasParent=', arr.map(a => Boolean(a.product?.parentId)))
  }
}
console.log('externalListingIds owned by >1 published listing:', dupExt, '/', byExt.size)

// ALSO: ownerSkuByItemId query is NOT restricted to published listings.
const allWithExt = await prisma.channelListing.findMany({
  where: { externalListingId: { not: null } },
  select: { externalListingId: true, listingStatus: true, isPublished: true, product: { select: { sku: true, parentId: true } } },
})
const byExtAll = new Map<string, typeof allWithExt>()
for (const l of allWithExt) {
  const a = byExtAll.get(l.externalListingId!) ?? []
  a.push(l); byExtAll.set(l.externalListingId!, a)
}
let dupExtAll = 0
const memItemIds = new Set(mems.map(m => m.itemId))
for (const [ext, arr] of byExtAll) {
  if (!memItemIds.has(ext)) continue
  if (arr.length > 1) {
    dupExtAll++
    if (dupExtAll <= 20) console.log(' EXT-ALL(itemId in memberships)', ext, 'n=', arr.length, arr.map(a => `${a.product?.sku}[pub=${a.isPublished},${a.listingStatus}]`))
  }
}
console.log('membership itemIds mapped by >1 ChannelListing (any status):', dupExtAll)

await prisma.$disconnect()
