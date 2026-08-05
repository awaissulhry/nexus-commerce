/** READ-ONLY: status of the families whose wire axis names changed. */
const { default: prisma } = await import('../src/db.js')
for (const sku of ['xracing', 'UD-LVLM-1H8T', 'REGAL-JACKET', 'VENTRA-JACKET', 'AIRMESH-JACKET']) {
  const p = await prisma.product.findFirst({ where: { sku }, select: { id: true, sku: true, variationTheme: true, createdAt: true, deletedAt: true } })
  if (!p) { console.log(`${sku}: NOT FOUND`); continue }
  const kids = await prisma.product.count({ where: { parentId: p.id, deletedAt: null } })
  const cls = await prisma.channelListing.findMany({
    where: { product: { OR: [{ id: p.id }, { parentId: p.id }] }, channel: 'EBAY' },
    select: { marketplace: true, listingStatus: true, externalListingId: true, isPublished: true, platformAttributes: true, product: { select: { sku: true } } },
  })
  const withItem = cls.filter((c) => c.externalListingId)
  const withOffers = cls.filter((c) => (c.platformAttributes as Record<string, unknown> | null)?.__offerIds)
  const memb = await prisma.sharedListingMembership.count({ where: { parentSku: p.sku } })
  console.log(`${sku}: kids=${kids} theme=${JSON.stringify(p.variationTheme)} deleted=${!!p.deletedAt} created=${p.createdAt.toISOString().slice(0, 10)}`)
  console.log(`   eBay CLs=${cls.length} statuses=${JSON.stringify([...new Set(cls.map((c) => c.listingStatus))])} withExternalId=${withItem.length} withOfferIds=${withOffers.length} memberships=${memb}`)
  const parentCl = cls.find((c) => c.product.sku === p.sku)
  const pa = (parentCl?.platformAttributes ?? {}) as Record<string, unknown>
  console.log(`   parent CL keys=${JSON.stringify(Object.keys(pa).filter((k) => k.startsWith('_')))} sharedFlag=${JSON.stringify(pa.shared_sku_listing ?? null)}`)
}
await prisma.$disconnect()
