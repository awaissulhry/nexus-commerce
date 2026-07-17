/** Purge dead fan-out entries (stale SKUs) + enqueue fresh pool-qty fan-out
 *  for every GALE pool product. Prod worker's backstop drain processes them. */
const { default: prisma } = await import('../src/db.js')
const { enqueueSharedTradingFanout } = await import('../src/services/ebay-shared-fanout.service.js')

// 1. Purge dead entries whose (itemId, sku) no longer exists as a membership
const dead = await prisma.outboundSyncQueue.deleteMany({
  where: { targetChannel: 'EBAY', syncStatus: 'FAILED', payload: { path: ['pushVia'], equals: 'TRADING' } },
})
console.log(`purged dead TRADING entries: ${dead.count}`)

// 2. Fresh fan-out per pool product with REAL warehouse availability
const children = await prisma.product.findMany({
  where: { parentId: 'cmokmy3a40078pm0p1fvnu523', deletedAt: null },
  select: { id: true, sku: true },
})
let enqueued = 0
for (const p of children) {
  const stock = await prisma.stockLevel.aggregate({
    where: { productId: p.id, location: { type: 'WAREHOUSE' } },
    _sum: { available: true },
  })
  const available = stock._sum.available ?? 0
  const ids = await enqueueSharedTradingFanout(prisma as never, {
    productId: p.id,
    warehouseAvailable: available,
    holdUntil: new Date(),
  })
  enqueued += ids.length
}
console.log(`enqueued fresh fan-out rows: ${enqueued} across ${children.length} products`)
const state = await prisma.outboundSyncQueue.groupBy({
  by: ['syncStatus'],
  where: { targetChannel: 'EBAY', payload: { path: ['pushVia'], equals: 'TRADING' } },
  _count: true,
})
console.log('queue state:', JSON.stringify(state))
await prisma.$disconnect()
process.exit(0)
