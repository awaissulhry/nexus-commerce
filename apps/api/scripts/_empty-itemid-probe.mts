/** READ-ONLY: locate the CL(s) with empty-string externalListingId. */
const { default: prisma } = await import('../src/db.js')
const bad = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', externalListingId: '' },
  select: { id: true, marketplace: true, region: true, listingStatus: true, product: { select: { sku: true, deletedAt: true } } },
})
console.log('EMPTY-ITEMID CLs:', JSON.stringify(bad.map((b) => `${b.product?.sku}@${b.marketplace ?? b.region} status=${b.listingStatus} deleted=${!!b.product?.deletedAt}`)))
await prisma.$disconnect()
