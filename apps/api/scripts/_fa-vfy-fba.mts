const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelListing.findMany({
  where: { channel: { not: 'AMAZON' }, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, product: { fulfillmentMethod: 'FBA' } },
  select: { id: true, channel: true, marketplace: true, quantity: true, syncPaused: true, listingStatus: true,
    fulfillmentMethod: true, externalListingId: true,
    product: { select: { sku: true, fulfillmentMethod: true } } },
})
const live = rows.filter(r => true)
console.log('TOTAL non-amazon w/ product FBA:', rows.length, 'live-ish:', live.length)
const byCh: Record<string, number> = {}
for (const r of live) byCh[`${r.channel}:${r.marketplace}`] = (byCh[`${r.channel}:${r.marketplace}`] ?? 0) + 1
console.log(byCh)
const gale = live.filter(r => r.product?.sku?.toUpperCase().includes('GALE'))
console.log('GALE non-amazon rows:', gale.length)
for (const r of gale.slice(0, 6)) console.log(' ', r.product?.sku, r.channel, r.marketplace, 'listingFm=', r.fulfillmentMethod, 'qty=', r.quantity, 'paused=', r.syncPaused, 'status=', r.listingStatus)
// how many would be blocked by routes guard
const blocked = live.filter(r => r.fulfillmentMethod === 'FBA' || (r.fulfillmentMethod == null && r.product?.fulfillmentMethod === 'FBA') || r.product?.fulfillmentMethod === 'FBA')
console.log('blockedByRoutesGuard:', blocked.length, 'of', live.length)
const stems: Record<string, number> = {}
for (const r of blocked) { const s = (r.product?.sku ?? '?').split('-').slice(0,2).join('-'); stems[s] = (stems[s] ?? 0) + 1 }
console.log(stems)
await prisma.$disconnect()
