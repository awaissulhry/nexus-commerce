import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON' },
  select: {
    id: true, productId: true, marketplace: true, isPublished: true, listingStatus: true,
    fulfillmentMethod: true, platformAttributes: true, quantity: true, quantityOverride: true,
    followMasterQuantity: true, syncPaused: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})

const pids = [...new Set(cls.map(c => c.productId))]
const fbaStock = await prisma.stockLevel.groupBy({
  by: ['productId'],
  where: { productId: { in: pids }, location: { code: 'AMAZON-EU-FBA' } },
  _sum: { quantity: true },
})
const fbaQty = new Map(fbaStock.map(s => [s.productId, s._sum.quantity ?? 0]))
const offers = await prisma.offer.findMany({
  where: { channelListingId: { in: cls.map(c => c.id) }, fulfillmentMethod: 'FBA', isActive: true },
  select: { channelListingId: true },
})
const offerSet = new Set(offers.map(o => o.channelListingId))

let weak = 0, strong = 0
const divergent: any[] = []
let published = 0
for (const c of cls) {
  const pub = c.isPublished && !['ENDED', 'REMOVED'].includes(String(c.listingStatus))
  if (pub) published++
  const w = c.fulfillmentMethod === 'FBA' || (c.fulfillmentMethod == null && c.product?.fulfillmentMethod === 'FBA') || c.product?.fulfillmentMethod === 'FBA'
  const fa = String((c.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase()
  const s = w || fa.startsWith('AMAZON') || (fbaQty.get(c.productId) ?? 0) > 0 || offerSet.has(c.id)
  if (pub && w) weak++
  if (pub && s) strong++
  if (s && !w) divergent.push({ pub, sku: c.product?.sku, mk: c.marketplace, clFm: c.fulfillmentMethod, prodFm: c.product?.fulfillmentMethod, fa, fbaQty: fbaQty.get(c.productId) ?? 0, offer: offerSet.has(c.id), q: c.quantity, qo: c.quantityOverride, follow: c.followMasterQuantity, status: c.listingStatus })
}
console.log(JSON.stringify({ totalAmazonCL: cls.length, published, weakPublished: weak, strongPublished: strong, divergentCount: divergent.length }, null, 2))
console.log(JSON.stringify(divergent.slice(0, 25), null, 2))

// how many published Amazon listings have a fa channel code at all
const faCounts: Record<string, number> = {}
for (const c of cls) {
  const fa = String((c.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '(none)').toUpperCase()
  faCounts[fa] = (faCounts[fa] ?? 0) + 1
}
console.log('faChannelCodes', JSON.stringify(faCounts))
const offCount = offers.length
const stockPids = [...fbaQty.entries()].filter(([, v]) => v > 0).length
console.log(JSON.stringify({ activeFbaOffers: offCount, productsWithFbaStock: stockPids }))
await prisma.$disconnect()
