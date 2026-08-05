/** READ-ONLY: RT.0 final verification — drift, failures, janitor, zombies, heal. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()

// 1. Drift re-check (same math as _rtq-probe.mts §3)
const listings = await prisma.channelListing.findMany({
  where: { channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] }, listingStatus: 'ACTIVE' },
  select: {
    channel: true, marketplace: true, followMasterQuantity: true, quantity: true,
    quantityOverride: true, stockBuffer: true, fulfillmentMethod: true, productId: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})
const pools = await prisma.stockLevel.groupBy({
  by: ['productId'], where: { location: { type: 'WAREHOUSE' } }, _sum: { available: true },
})
const poolBy = new Map(pools.map((p) => [p.productId, p._sum.available ?? 0]))
let ok = 0, drift = 0, nullQ = 0
const samples: string[] = []
for (const l of listings) {
  const fba = l.channel === 'AMAZON' && ((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA'))
  if (fba || !l.followMasterQuantity) continue
  const expected = Math.max(0, (poolBy.get(l.productId) ?? 0) - (l.stockBuffer ?? 0))
  if (l.quantity == null) { nullQ++; continue }
  if (l.quantity !== expected) {
    drift++
    if (samples.length < 8) samples.push(`${l.product?.sku}@${l.channel}:${l.marketplace} qty=${l.quantity} exp=${expected}`)
  } else ok++
}
console.log(`== 1. Following FBM ACTIVE drift: ok=${ok} drift=${drift} nullQty=${nullQ} ==`)
for (const s of samples) console.log('  DRIFT', s)

// 2. eBay failures last 90min by errorCode
const fails = await prisma.outboundSyncQueue.groupBy({
  by: ['errorCode', 'targetChannel'],
  where: { syncStatus: 'FAILED', updatedAt: { gte: new Date(now - 90 * 60e3) } },
  _count: { _all: true },
})
console.log('== 2. FAILED rows last 90min by errorCode ==')
console.log(JSON.stringify(fails.map((f) => `${f.targetChannel}:${f.errorCode}=${f._count._all}`)))

// 3. Heal-verify row + memberships
const verifyRow = await prisma.outboundSyncQueue.findFirst({
  where: { payload: { path: ['source'], equals: 'RT0_HEAL_VERIFY' } },
  select: { syncStatus: true, errorCode: true, isDead: true },
})
const mems = await prisma.sharedListingMembership.groupBy({
  by: ['status'], where: { itemId: '256552369326' }, _count: { _all: true },
})
console.log('== 3. heal:', JSON.stringify(verifyRow), 'memberships:', JSON.stringify(mems.map((m) => `${m.status}=${m._count._all}`)))

// 4. Zombies + janitor
const zombies = await prisma.outboundSyncQueue.count({
  where: { syncStatus: { in: ['PENDING', 'IN_PROGRESS'] }, createdAt: { lt: new Date(now - 3 * 24 * 3600e3) } },
})
const invisibleTerminals = await prisma.outboundSyncQueue.count({
  where: { syncStatus: 'FAILED', isDead: false, errorCode: 'MAX_RETRIES_EXCEEDED' },
})
const janitor = await prisma.cronRun.findFirst({
  where: { jobName: 'outbound-queue-janitor' },
  orderBy: { startedAt: 'desc' },
  select: { startedAt: true, status: true, detail: true } as never,
}).catch(async () => prisma.cronRun.findFirst({
  where: { jobName: 'outbound-queue-janitor' },
  orderBy: { startedAt: 'desc' },
}))
console.log(`== 4. zombies(>3d PENDING/IN_PROGRESS)=${zombies} invisibleTerminals=${invisibleTerminals} janitorLastRun=${janitor ? JSON.stringify(janitor) : 'NOT YET RUN'}`)

// 5. No-ledger recount
const prods = await prisma.product.findMany({ where: { totalStock: { gt: 0 } }, select: { id: true } })
const still = prods.filter((p) => !poolBy.has(p.id)).length
console.log(`== 5. no-ledger products remaining: ${still} ==`)

await prisma.$disconnect()
process.exit(0)
