const { default: prisma } = await import('../src/db.js')
const master = await prisma.product.findFirst({ where: { sku: 'AIREON', parentId: null }, select: { id: true } })
const ids = [master!.id, ...(await prisma.product.findMany({ where: { parentId: master!.id }, select: { id: true } })).map((k) => k.id)]
for (const mkt of ['DE', 'ES', 'FR']) {
  const total = await prisma.channelListing.count({ where: { productId: { in: ids }, channel: 'AMAZON', marketplace: mkt, isPublished: true } })
  const closed = await prisma.channelListing.count({ where: { productId: { in: ids }, channel: 'AMAZON', marketplace: mkt, offerClosedAt: { not: null } } })
  console.log(`${mkt}: ${closed}/${total} closed`)
}
await prisma.$disconnect()
