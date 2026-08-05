import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const folded = ['IT-GALE-JACKET', 'GALE-JACKET-ALT1', 'GALE-JACKET-ALT2', 'GALE-JACKET-ALT3', 'xavia-knee-slider-ALT1', 'xavia-knee-slider-ALT2']
const ps = await prisma.product.findMany({ where: { sku: { in: folded } }, select: { id: true, sku: true, parentId: true } })
for (const p of ps) {
  const cls = await prisma.channelListing.findMany({
    where: { productId: p.id, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: { channel: true, marketplace: true, externalListingId: true, quantity: true, followMasterQuantity: true, syncPaused: true },
  })
  console.log(`ROWS ${p.sku} parentId=${p.parentId} listings=${cls.length}`)
  for (const c of cls) console.log(`   -> ${c.channel} ${c.marketplace} item=${c.externalListingId} qty=${c.quantity} follow=${c.followMasterQuantity} paused=${c.syncPaused}`)
}
await prisma.$disconnect()
