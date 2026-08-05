const { default: prisma } = await import('../src/db.js')

const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', product: { sku: { contains: 'WATERPROOF' } } },
  select: {
    id: true, region: true, marketplace: true, listingStatus: true, externalListingId: true,
    platformAttributes: true, flatFileSnapshot: true,
    product: { select: { sku: true, parentId: true, isParent: true, variationTheme: true } },
  },
  orderBy: { region: 'asc' },
})
console.log('COUNT', cls.length)
for (const c of cls) {
  const pa = (c.platformAttributes ?? {}) as Record<string, unknown>
  const snap = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  const its = (pa.itemSpecifics ?? {}) as Record<string, unknown>
  console.log(JSON.stringify({
    sku: c.product.sku, region: c.region, mkt: c.marketplace, status: c.listingStatus,
    itemId: c.externalListingId, theme: c.product.variationTheme, isParent: c.product.isParent,
    itemSpecificKeys: Object.keys(its),
    snapAspectKeys: Object.keys(snap).filter(k => k.startsWith('aspect_')),
  }))
}
await prisma.$disconnect()
