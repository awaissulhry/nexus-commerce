const { default: prisma } = await import('../src/db.js')
const l = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', followMasterQuantity: false, listingStatus: { not: 'ENDED' }, product: { sku: 'GALE-JACKET-BLACK-MEN-S' } },
  select: { marketplace: true, fulfillmentMethod: true, quantity: true, quantityOverride: true, listingStatus: true, product: { select: { fulfillmentMethod: true, totalStock: true } } },
})
console.log(JSON.stringify(l))
await prisma.$disconnect()
process.exit(0)
