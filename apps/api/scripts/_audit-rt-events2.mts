const { default: prisma } = await import('../src/db.js')

// Any ProductEvent at all within 5 min of the ALT master creation window?
const win = await prisma.productEvent.findMany({
  where: { createdAt: { gte: new Date('2026-07-17T15:00:00Z'), lte: new Date('2026-07-17T15:20:00Z') } },
  select: { aggregateId: true, aggregateType: true, eventType: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
  take: 30,
})
console.log('=== ProductEvents 2026-07-17 15:00-15:20 (ALT creation window) ===', win.length)
for (const e of win) console.log(e.createdAt.toISOString(), e.eventType, e.aggregateType, e.aggregateId)

// Do the ALT masters even have ChannelListings (i.e. would a downstream emit have fired)?
const alts = await prisma.product.findMany({
  where: { sku: { in: ['GALE-JACKET-ALT1', 'GALE-JACKET-ALT2', 'GALE-JACKET-ALT3', 'IT-GALE-JACKET'] } },
  select: { id: true, sku: true, createdAt: true, _count: { select: { children: true } } },
})
for (const a of alts) {
  const cls = await prisma.channelListing.count({ where: { productId: a.id } })
  const childIds = await prisma.product.findMany({ where: { parentId: a.id }, select: { id: true } })
  const childCls = childIds.length
    ? await prisma.channelListing.count({ where: { productId: { in: childIds.map((c) => c.id) } } })
    : 0
  console.log(`\n${a.sku}: children=${a._count.children} ownCLs=${cls} childCLs=${childCls} created=${a.createdAt.toISOString()}`)
}
await prisma.$disconnect()
