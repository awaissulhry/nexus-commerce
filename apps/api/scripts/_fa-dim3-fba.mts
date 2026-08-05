const { default: prisma } = await import('../src/db.js')
const out = (k: string, v: unknown) => console.log('###', k, JSON.stringify(v, null, 1))

const amz = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { id: true, productId: true, marketplace: true, fulfillmentMethod: true, platformAttributes: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const fbaStock = await prisma.stockLevel.groupBy({ by: ['productId'], where: { location: { code: 'AMAZON-EU-FBA' } }, _sum: { quantity: true } })
const fq = new Map(fbaStock.map((s) => [s.productId, s._sum.quantity ?? 0]))
const offers = await prisma.offer.findMany({ where: { fulfillmentMethod: 'FBA', isActive: true }, select: { channelListingId: true } })
const offerSet = new Set(offers.map((o) => o.channelListingId).filter(Boolean) as string[])

const pa = (c: any) => String((c.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase().startsWith('AMAZON')
const weak = (c: any) => c.fulfillmentMethod === 'FBA' || (c.fulfillmentMethod == null && c.product?.fulfillmentMethod === 'FBA') || c.product?.fulfillmentMethod === 'FBA'
const strong = (c: any) => c.fulfillmentMethod === 'FBA' || pa(c) || c.product?.fulfillmentMethod === 'FBA' || (fq.get(c.productId) ?? 0) > 0 || offerSet.has(c.id)

const weakSet = amz.filter(weak)
// how many weak-FBA rows are carried ONLY by the product-level flag?
const onlyProductFlag = weakSet.filter((c) => c.fulfillmentMethod !== 'FBA' && !pa(c) && (fq.get(c.productId) ?? 0) === 0 && !offerSet.has(c.id))
// rows strong-FBA but NOT weak-FBA (the routes' PAUSE/RESUME/ZERO_PIN would write them)
const gap = amz.filter((c) => !weak(c) && strong(c))
out('summary', {
  amazonPublished: amz.length,
  weakFba: weakSet.length,
  strongFba: amz.filter(strong).length,
  weakFbaCarriedOnlyByProductFlag: onlyProductFlag.length,
  ROUTES_GUARD_GAP_strongButNotWeak: gap.length,
  gapSample: gap.slice(0, 10).map((c) => ({ sku: c.product?.sku, mk: c.marketplace, fm: c.fulfillmentMethod, pfm: c.product?.fulfillmentMethod, pa: pa(c), fbaQty: fq.get(c.productId) ?? 0, activeFbaOffer: offerSet.has(c.id) })),
})
// how many follow-master would ALSO write if product flag flipped to FBM
const survivesFlagFlip = weakSet.filter((c) => c.fulfillmentMethod === 'FBA' || pa(c) || (fq.get(c.productId) ?? 0) > 0 || offerSet.has(c.id))
out('ifProductFlagFlippedToFBM', {
  totalWeakFba: weakSet.length,
  stillCaughtBy_isFbaListing: survivesFlagFlip.length,
  becomesWritableByRoutesGuard: weakSet.length - survivesFlagFlip.length,
})
await prisma.$disconnect()
