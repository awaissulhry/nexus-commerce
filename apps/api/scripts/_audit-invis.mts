const { default: prisma } = await import('../src/db.js')
const gale = await prisma.product.findMany({ where: { sku: { contains: 'GALE' } }, select: { id: true, sku: true, parentId: true } })
const ids = gale.map(g => g.id)
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: ids }, listingStatus: { not: 'ENDED' } },
  select: { id: true, productId: true, channel: true, marketplace: true, isPublished: true, listingStatus: true, externalListingId: true, quantity: true, followMasterQuantity: true },
})
const skuOf = new Map(gale.map(g => [g.id, g.sku]))
const vis = cls.filter(c => c.isPublished && c.listingStatus !== 'REMOVED')
const invis = cls.filter(c => !(c.isPublished && c.listingStatus !== 'REMOVED'))
console.log('GALE total non-ENDED listings', cls.length, 'visible', vis.length, 'invisible', invis.length)
const byKey = (a:any[]) => { const m = new Map<string,number>(); for (const c of a) { const k = `${c.channel}:${c.marketplace}`; m.set(k,(m.get(k)??0)+1) } return [...m].sort() }
console.log('visible markets', byKey(vis))
console.log('invisible markets', byKey(invis))
const visMarkets = new Set(vis.filter(c=>c.channel==='AMAZON').map(c=>c.marketplace))
const overlap = invis.filter(c => c.channel==='AMAZON' && visMarkets.has(c.marketplace))
console.log('invisible AMAZON in a visible market (would be swept):', overlap.length)
console.log(overlap.slice(0,8).map(c => `${skuOf.get(c.productId)}@${c.marketplace} pub=${c.isPublished} st=${c.listingStatus} ext=${c.externalListingId?'Y':'N'} qty=${c.quantity} follow=${c.followMasterQuantity}`))
// REMOVED but published?
const remPub = cls.filter(c => c.listingStatus === 'REMOVED' && c.isPublished)
console.log('REMOVED & isPublished=true:', remPub.length, remPub.slice(0,5).map(c=>`${skuOf.get(c.productId)}@${c.channel}:${c.marketplace}`))
// global
const gRem = await prisma.channelListing.count({ where: { listingStatus: 'REMOVED', isPublished: true } })
const gUnpub = await prisma.channelListing.count({ where: { isPublished: false, listingStatus: { not: 'ENDED' } } })
console.log('GLOBAL REMOVED&published', gRem, ' GLOBAL unpublished non-ENDED', gUnpub)
await prisma.$disconnect()
