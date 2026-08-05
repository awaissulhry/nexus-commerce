const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, channel: 'EBAY' },
  select: { productId: true, marketplace: true, followMasterQuantity: true, syncPaused: true, fulfillmentMethod: true, product: { select: { sku: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { sku: true, marketplace: true, itemId: true, followPool: true } })
const L = new Map(listings.map(l => [`${l.product?.sku}|${l.marketplace}`, l]))
let excluded = 0, exclHasListing = 0
const combos = new Map<string, number>()
for (const m of mems) {
  const l = L.get(`${m.sku}|${m.marketplace}`)
  const memMode = (m.followPool ?? true) ? 'FOLLOW' : 'EXCLUDED'
  const lMode = !l ? 'NO-LISTING' : l.syncPaused ? 'PAUSED' : (l.followMasterQuantity ? 'FOLLOW' : 'PINNED')
  combos.set(`mem=${memMode} listing=${lMode}`, (combos.get(`mem=${memMode} listing=${lMode}`) ?? 0) + 1)
  if (memMode === 'EXCLUDED') { excluded++; if (l) exclHasListing++ }
}
console.log([...combos.entries()].sort((a,b)=>b[1]-a[1]))
console.log('excluded memberships', excluded, 'of which listing-lane row exists', exclHasListing)
await prisma.$disconnect()
