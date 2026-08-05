const { default: prisma } = await import('../src/db.js')

const out = (k: string, v: unknown) => console.log('###', k, JSON.stringify(v, null, 1))

// 1. non-AMAZON listings that the routes' inline FBA guard would skip
const nonAmzFba = await prisma.channelListing.findMany({
  where: {
    channel: { not: 'AMAZON' },
    isPublished: true,
    listingStatus: { notIn: ['ENDED', 'REMOVED'] },
    OR: [{ fulfillmentMethod: 'FBA' }, { product: { fulfillmentMethod: 'FBA' } }],
  },
  select: { id: true, channel: true, marketplace: true, fulfillmentMethod: true, product: { select: { sku: true, fulfillmentMethod: true } } },
  take: 20,
})
const nonAmzFbaCount = await prisma.channelListing.count({
  where: {
    channel: { not: 'AMAZON' },
    isPublished: true,
    listingStatus: { notIn: ['ENDED', 'REMOVED'] },
    OR: [{ fulfillmentMethod: 'FBA' }, { product: { fulfillmentMethod: 'FBA' } }],
  },
})
out('nonAmazonListingsBlockedByFbaGuard', { count: nonAmzFbaCount, sample: nonAmzFba.slice(0, 8) })

// 2. AMAZON listings FBA only by platformAttributes / fba stock evidence
const amz = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { id: true, productId: true, marketplace: true, fulfillmentMethod: true, platformAttributes: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const fbaStock = await prisma.stockLevel.groupBy({
  by: ['productId'],
  where: { location: { code: 'AMAZON-EU-FBA' } },
  _sum: { quantity: true },
})
const fbaQty = new Map(fbaStock.map((s) => [s.productId, s._sum.quantity ?? 0]))
const weak = (cl: any) => cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') || cl.product?.fulfillmentMethod === 'FBA'
const strongPA = (cl: any) => String((cl.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase().startsWith('AMAZON')
const strongStock = (cl: any) => (fbaQty.get(cl.productId) ?? 0) > 0
const gapPA = amz.filter((c) => !weak(c) && strongPA(c))
const gapStock = amz.filter((c) => !weak(c) && strongStock(c))
out('amazonTotals', { published: amz.length, weakFba: amz.filter(weak).length })
out('FBA_GAP_platformAttributes', { count: gapPA.length, sample: gapPA.slice(0, 8).map((c) => ({ sku: c.product?.sku, mk: c.marketplace, fm: c.fulfillmentMethod, pfm: c.product?.fulfillmentMethod, fac: (c.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code })) })
out('FBA_GAP_fbaStockEvidence', { count: gapStock.length, sample: gapStock.slice(0, 8).map((c) => ({ sku: c.product?.sku, mk: c.marketplace, fm: c.fulfillmentMethod, pfm: c.product?.fulfillmentMethod, fbaQty: fbaQty.get(c.productId) })) })

// 3. total expansion size (select every product)
const totalListings = await prisma.channelListing.count({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } } })
const totalMems = await prisma.sharedListingMembership.count({ where: { status: 'ACTIVE' } })
out('expansionTotals', { totalListings, totalMems, sum: totalListings + totalMems, cap: 3000 })

// 4. duplicate (productId, channel, marketplace) rows incl ENDED/unpublished
const allCl = await prisma.channelListing.findMany({ select: { id: true, productId: true, channel: true, marketplace: true, isPublished: true, listingStatus: true, quantity: true, product: { select: { sku: true } } } })
const byTriple = new Map<string, typeof allCl>()
for (const c of allCl) {
  const k = `${c.productId}|${c.channel}|${c.marketplace}`
  const a = byTriple.get(k) ?? []
  a.push(c); byTriple.set(k, a)
}
const dupTriples = [...byTriple.entries()].filter(([, v]) => v.length > 1)
const dupWithDead = dupTriples.filter(([, v]) => v.some((x) => x.isPublished && !['ENDED', 'REMOVED'].includes(x.listingStatus ?? '')) && v.some((x) => !x.isPublished || ['ENDED', 'REMOVED'].includes(x.listingStatus ?? '')))
out('duplicateTriples', { total: dupTriples.length, liveAndDeadMixed: dupWithDead.length, sample: dupWithDead.slice(0, 6).map(([k, v]) => ({ k, rows: v.map((x) => ({ id: x.id.slice(0, 8), sku: x.product?.sku, pub: x.isPublished, st: x.listingStatus, q: x.quantity })) })) })

// 5. cross-product hazard: products with listings on >1 Amazon marketplace, within one family
const amzByProduct = new Map<string, Set<string>>()
for (const c of amz) {
  const s = amzByProduct.get(c.productId) ?? new Set<string>()
  s.add(c.marketplace); amzByProduct.set(c.productId, s)
}
const multiMarket = [...amzByProduct.entries()].filter(([, s]) => s.size > 1)
out('amazonMultiMarketProducts', { count: multiMarket.length, sample: multiMarket.slice(0, 5).map(([p, s]) => ({ p: p.slice(0, 8), markets: [...s] })) })

await prisma.$disconnect()
