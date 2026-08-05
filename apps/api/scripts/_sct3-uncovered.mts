/** READ-ONLY: the 4 'uncovered' parents — do their eBay CLs point at live
 *  items at all, or are they corpse rows that should not be in scope? */
const { default: prisma } = await import('../src/db.js')
for (const sku of ['VENTRA-JACKET-ALT1', 'AIR-MESH-JACKET-MEN', 'REGAL-JACKET-ALT1', 'VENTRA-JACKET-ALT2']) {
  const p = await prisma.product.findFirst({ where: { sku }, select: { id: true, deletedAt: true } })
  if (!p) { console.log(`${sku}: no product`); continue }
  const cls = await prisma.channelListing.findMany({
    where: { productId: p.id, channel: 'EBAY' },
    select: { marketplace: true, isPublished: true, listingStatus: true, externalListingId: true, quantity: true, followMasterQuantity: true },
  })
  // does the EXTERNAL item id have memberships under ANY product?
  for (const c of cls) {
    const mems = c.externalListingId
      ? await prisma.sharedListingMembership.count({ where: { itemId: c.externalListingId, status: 'ACTIVE' } })
      : 0
    console.log(`${sku} ${c.marketplace} pub=${c.isPublished} st=${c.listingStatus} ext=${c.externalListingId ?? '-'} qty=${c.quantity} follow=${c.followMasterQuantity} → memberships on that itemId: ${mems}`)
  }
}
await prisma.$disconnect()
