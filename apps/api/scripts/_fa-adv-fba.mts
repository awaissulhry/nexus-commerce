const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
  select: { id: true, productId: true, channel: true, marketplace: true, quantity: true, fulfillmentMethod: true,
    followMasterQuantity: true, syncPaused: true, externalListingId: true,
    product: { select: { sku: true, fulfillmentMethod: true } } },
})
console.log('published listings', listings.length)
const mismatch = listings.filter(l => {
  const sc = l.fulfillmentMethod === 'FBA' || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA') || l.product?.fulfillmentMethod === 'FBA'
  const engineExplicit = l.fulfillmentMethod === 'FBA' || l.fulfillmentMethod === 'FBM'
  const merchant = ['EBAY','SHOPIFY','WOO','ETSY'].includes(l.channel)
  const eng = engineExplicit ? l.fulfillmentMethod : (merchant ? 'FBM' : (l.product?.fulfillmentMethod === 'FBA' ? 'FBA':'FBM'))
  return sc && eng === 'FBM'
})
console.log('SC=FBA engine=FBM count', mismatch.length)
const byCh: Record<string, number> = {}
for (const m of mismatch) byCh[`${m.channel}:${m.marketplace}:lfm=${m.fulfillmentMethod}:pfm=${m.product?.fulfillmentMethod}`] = (byCh[`${m.channel}:${m.marketplace}:lfm=${m.fulfillmentMethod}:pfm=${m.product?.fulfillmentMethod}`]||0)+1
console.log(byCh)
console.log(mismatch.slice(0,5).map(m=>({id:m.id,sku:m.product?.sku,ext:m.externalListingId,qty:m.quantity,follow:m.followMasterQuantity,paused:m.syncPaused})))
await prisma.$disconnect()
