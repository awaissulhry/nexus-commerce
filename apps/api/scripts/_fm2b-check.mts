import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
const FAM = 'cmonjewg10001o701j5cqpfzs'
const TARGET = 'AIRMESH-JACKET-BLACK-MEN-M'
const prods = await prisma.product.findMany({
  where: { OR: [{ id: FAM }, { parentId: FAM }] },
  select: {
    id: true, sku: true, parentId: true, totalStock: true,
    stockLevels: { select: { quantity: true, available: true, location: { select: { type: true } } } },
    channelListings: {
      where: { channel: 'EBAY', marketplace: 'IT', listingStatus: { not: 'ENDED' } },
      select: { id: true, quantity: true, quantityOverride: true, followMasterQuantity: true, listingStatus: true, version: true, lastSyncStatus: true },
    },
  },
  orderBy: { sku: 'asc' },
})
console.log('=== AIRMESH family: parent + %d rows ===', prods.length)
let poolSum = 0
for (const p of prods) {
  const wh = p.stockLevels.filter(s => s.location?.type === 'WAREHOUSE').reduce((a, s) => a + s.quantity, 0)
  const fba = p.stockLevels.filter(s => s.location?.type === 'AMAZON_FBA').reduce((a, s) => a + s.quantity, 0)
  poolSum += (p.totalStock ?? 0) + wh
  const cl = p.channelListings[0]
  const mark = p.sku === TARGET ? ' <<< TARGET' : ''
  console.log(`${p.sku} | ${p.parentId ? 'child' : 'PARENT'} | pool(total=${p.totalStock},wh=${wh},fba=${fba}) | eBayIT=${cl ? `{id:${cl.id.slice(-6)},qty:${cl.quantity},ovr:${cl.quantityOverride},follow:${cl.followMasterQuantity},v${cl.version},${cl.lastSyncStatus}}` : 'none'}${mark}`)
}
console.log('POOL FINGERPRINT (sum of totalStock+warehouse across family):', poolSum)
const pids = prods.map(p => p.id)
const q = await prisma.outboundSyncQueue.findMany({
  where: { productId: { in: pids }, syncStatus: { in: ['PENDING', 'PROCESSING', 'RETRY'] } },
  select: { id: true, productId: true, syncType: true, syncStatus: true, targetChannel: true, payload: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
})
console.log('=== Pending/active queue rows for family: %d ===', q.length)
for (const r of q) {
  const src = (r.payload as any)?.source ?? '?'
  const qty = (r.payload as any)?.quantity ?? '?'
  console.log(`  queue ${r.id.slice(-6)} | ${r.syncType} | ${r.syncStatus} | ${r.targetChannel} | src=${src} qty=${qty} | ${r.createdAt.toISOString()}`)
}
await prisma.$disconnect(); process.exit(0)
