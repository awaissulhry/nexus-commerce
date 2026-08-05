/** READ-ONLY: where do VENTRA's ItemIDs actually live, and do they agree? */
const { default: prisma } = await import('../src/db.js')
const roots = await prisma.product.findMany({
  where: { sku: { startsWith: 'VENTRA' }, deletedAt: null },
  select: { id: true, sku: true, productType: true, parentId: true },
  orderBy: { sku: 'asc' },
})
for (const r of roots.filter(x => !x.parentId)) {
  console.log(`\n═══ ${r.sku}  (${r.productType ?? 'PRODUCT'}) ═══`)
  const cls = await prisma.channelListing.findMany({
    where: { productId: r.id, channel: 'EBAY' },
    select: { region: true, externalListingId: true, listingStatus: true },
  })
  console.log('  ChannelListing.externalListingId:',
    cls.length ? cls.map(c => `${c.region}=${c.externalListingId ?? 'NULL'}(${c.listingStatus ?? '-'})`).join('  ') : '(none)')
  const mem = await prisma.sharedListingMembership.groupBy({
    by: ['itemId', 'marketplace', 'status'],
    where: { parentSku: r.sku },
    _count: { _all: true },
  })
  console.log('  SharedListingMembership.itemId:',
    mem.length ? mem.map(m => `${m.marketplace}/${m.itemId} ${m.status} x${m._count._all}`).join('  ') : '(none)')
}
await prisma.$disconnect()
