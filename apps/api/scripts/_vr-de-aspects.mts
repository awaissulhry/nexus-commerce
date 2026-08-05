import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { id: true, region: true, marketplace: true, listingStatus: true, externalListingId: true, platformAttributes: true, productId: true, updatedAt: true },
})
const byMkt = new Map<string, number>()
for (const l of listings) byMkt.set(l.marketplace, (byMkt.get(l.marketplace) ?? 0) + 1)
console.log('eBay ChannelListings by marketplace:', [...byMkt.entries()])

const de = listings.filter((l) => l.marketplace === 'DE' || l.region === 'DE')
console.log('DE listing count:', de.length)
for (const l of de) {
  const a = (l.platformAttributes ?? {}) as Record<string, unknown>
  const spec = (a.itemSpecifics ?? {}) as Record<string, string>
  const snap = a.flatFileSnapshot as Record<string, unknown> | undefined
  const snapAspects = snap ? Object.keys(snap).filter((k) => k.startsWith('aspect_')) : null
  console.log('--', l.region, l.marketplace, l.listingStatus, l.externalListingId, 'specKeys=', Object.keys(spec), 'snapAspects=', snapAspects)
}

// which products are in the DE-scoped file (listed scope, marketplace DE)?
const prods = await prisma.product.findMany({
  where: {
    deletedAt: null,
    OR: [
      { channelListings: { some: { channel: 'EBAY', marketplace: 'DE' } } },
      { parent: { channelListings: { some: { channel: 'EBAY', marketplace: 'DE' } } } },
      { children: { some: { channelListings: { some: { channel: 'EBAY', marketplace: 'DE' } } } } },
    ],
  },
  select: { id: true, sku: true, parentId: true, variationTheme: true, categoryAttributes: true, variantAttributes: true,
    channelListings: { where: { channel: 'EBAY' }, select: { region: true, marketplace: true, platformAttributes: true, updatedAt: true } } },
})
console.log('\nDE-scoped products:', prods.length)
for (const p of prods) {
  // emulate FFP.1 sort: DE listing first
  const sorted = [...p.channelListings].sort((a, b) => {
    const aa = a.region === 'DE' ? 1 : 0, bb = b.region === 'DE' ? 1 : 0
    if (aa !== bb) return bb - aa
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
  const first = sorted[0]
  const attrs = (first?.platformAttributes ?? {}) as Record<string, unknown>
  const spec = (attrs.itemSpecifics ?? {}) as Record<string, string>
  const snap = attrs.flatFileSnapshot as Record<string, unknown> | undefined
  const snapA = snap ? Object.keys(snap).filter((k) => k.startsWith('aspect_')) : []
  console.log(p.sku, '| firstRegion=', first?.region, '| specKeys=', Object.keys(spec).join(','), '| snapAspect=', snapA.join(','))
}
await prisma.$disconnect()
