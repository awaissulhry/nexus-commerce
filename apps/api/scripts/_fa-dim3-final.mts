const { default: prisma } = await import('../src/db.js')
const out = (k: string, v: unknown) => console.log('###', k, JSON.stringify(v, null, 1))
const paFba = (c: any) => String((c.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase().startsWith('AMAZON')

const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true } })
const kids = await prisma.product.findMany({ where: { parentId: gale!.id }, select: { id: true } })
const pids = kids.map((k) => k.id)

const rows = await prisma.channelListing.findMany({
  where: { productId: { in: pids }, channel: 'AMAZON', listingStatus: { not: 'ENDED' }, isPublished: false },
  select: { id: true, marketplace: true, quantity: true, quantityOverride: true, followMasterQuantity: true, fulfillmentMethod: true, platformAttributes: true, listingStatus: true, externalListingId: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const fbaStock = await prisma.stockLevel.groupBy({ by: ['productId'], where: { productId: { in: pids }, location: { type: 'AMAZON_FBA' } }, _sum: { quantity: true } })
const fq = new Map(fbaStock.map((s) => [s.productId, s._sum.quantity ?? 0]))
out('GALE_unpublished_amazon_rows_writtenByFOLLOW_PIN_BUFFER', rows.map((r) => ({
  sku: r.product?.sku, mk: r.marketplace, st: r.listingStatus, isPublished: false, q: r.quantity, qo: r.quantityOverride,
  follow: r.followMasterQuantity, ext: r.externalListingId ?? null,
  skippedAsFba: r.fulfillmentMethod === 'FBA' || paFba(r) || r.product?.fulfillmentMethod === 'FBA',
})))

const ebay = await prisma.channelListing.findMany({
  where: { productId: { in: pids }, channel: 'EBAY', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { id: true, marketplace: true, syncPaused: true, fulfillmentMethod: true, quantity: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const weakBlocked = ebay.filter((c) => c.fulfillmentMethod === 'FBA' || (c.fulfillmentMethod == null && c.product?.fulfillmentMethod === 'FBA') || c.product?.fulfillmentMethod === 'FBA')
out('GALE_ebay_listing_rows', { total: ebay.length, blockedByRoutesFbaGuard: weakBlocked.length, sample: weakBlocked.slice(0, 5).map((c) => ({ sku: c.product?.sku, mk: c.marketplace, listingFm: c.fulfillmentMethod, productFm: c.product?.fulfillmentMethod, syncPaused: c.syncPaused, qty: c.quantity })) })

const mems = await prisma.sharedListingMembership.findMany({ where: { productId: { in: pids }, status: 'ACTIVE' }, select: { itemId: true, sku: true, followPool: true, lastQtyPushed: true } })
const byItem = new Map<string, number>()
for (const m of mems) byItem.set(m.itemId, (byItem.get(m.itemId) ?? 0) + 1)
out('GALE_active_memberships_untouched_by_PAUSE_ZEROPIN', { total: mems.length, stillFollowingPool: mems.filter((m) => m.followPool !== false).length, perItemId: [...byItem.entries()] })

// FBA guard divergence (no service import — inline)
const amz = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { id: true, productId: true, marketplace: true, fulfillmentMethod: true, platformAttributes: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const fbaStock2 = await prisma.stockLevel.groupBy({ by: ['productId'], where: { location: { code: 'AMAZON-EU-FBA' } }, _sum: { quantity: true } })
const fq2 = new Map(fbaStock2.map((s) => [s.productId, s._sum.quantity ?? 0]))
const offers = await prisma.offer.findMany({ where: { fulfillmentMethod: 'FBA', isActive: true }, select: { channelListingId: true } })
const offerSet = new Set(offers.map((o) => o.channelListingId).filter(Boolean) as string[])
const weak = (c: any) => c.fulfillmentMethod === 'FBA' || (c.fulfillmentMethod == null && c.product?.fulfillmentMethod === 'FBA') || c.product?.fulfillmentMethod === 'FBA'
const strong = (c: any) => c.fulfillmentMethod === 'FBA' || paFba(c) || c.product?.fulfillmentMethod === 'FBA' || (fq2.get(c.productId) ?? 0) > 0 || offerSet.has(c.id)
const weakSet = amz.filter(weak)
const gap = amz.filter((c) => !weak(c) && strong(c))
const survives = weakSet.filter((c) => c.fulfillmentMethod === 'FBA' || paFba(c) || (fq2.get(c.productId) ?? 0) > 0 || offerSet.has(c.id))
out('FBA_guard_divergence', {
  amazonPublished: amz.length, weakFba: weakSet.length, strongFba: amz.filter(strong).length,
  ROUTES_GAP_strongButNotWeak: gap.length,
  gapSample: gap.slice(0, 10).map((c) => ({ sku: c.product?.sku, mk: c.marketplace, fm: c.fulfillmentMethod, pfm: c.product?.fulfillmentMethod, pa: paFba(c), fbaQty: fq2.get(c.productId) ?? 0, activeFbaOffer: offerSet.has(c.id) })),
  ifProductFlagFlipped_stillCaught: survives.length,
  ifProductFlagFlipped_becomesWritable: weakSet.length - survives.length,
})
await prisma.$disconnect()
