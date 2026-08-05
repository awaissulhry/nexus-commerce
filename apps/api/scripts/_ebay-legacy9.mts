/** READ-ONLY: identify the 9 non-shared ACTIVE eBay listings the Inventory sweep errors on. */
const { default: prisma } = await import('../src/db.js')
const shared = new Set(
  (await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { sku: true } })).map((m) => m.sku),
)
const listings = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', listingStatus: 'ACTIVE' },
  select: { id: true, marketplace: true, quantity: true, externalListingId: true, isPublished: true, product: { select: { sku: true, totalStock: true } } },
})
const nonShared = listings.filter((l) => l.product?.sku && !shared.has(l.product.sku))
console.log(`ACTIVE EBAY ChannelListings: ${listings.length}; non-shared (the sweep set): ${nonShared.length}`)
for (const l of nonShared) {
  console.log(
    `  ${l.product?.sku?.padEnd(38)} mp=${l.marketplace} qty=${l.quantity} pool=${l.product?.totalStock} ext=${l.externalListingId ?? '-'} pub=${l.isPublished}`,
  )
}
await prisma.$disconnect()
process.exit(0)
