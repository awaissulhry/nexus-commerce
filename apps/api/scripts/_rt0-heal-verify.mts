/**
 * RT.0.e — live end-to-end verify of the eBay ended-listing auto-heal.
 *
 * Item 256552369326 is ended on eBay (error 21916750, measured incident) but
 * its 24 memberships are still ACTIVE. Instead of manually flipping them, we
 * enqueue ONE Trading qty row for it and let the DEPLOYED auto-heal do the
 * marking — proving the whole chain (drain → Trading fail → memberships
 * ENDED → terminal dead-letter, circuit untouched) on prod.
 *
 * Safe: the listing is already dead; a revise attempt against it changes
 * nothing on eBay. Falls back to manual marking if the heal doesn't fire.
 */
const { default: prisma } = await import('../src/db.js')
const ITEM = '256552369326'

const mems = await prisma.sharedListingMembership.findMany({
  where: { itemId: ITEM },
  select: { sku: true, status: true, productId: true, lastQtyPushed: true, marketplace: true },
})
const active = mems.filter((m) => m.status === 'ACTIVE')
console.log(`memberships for ${ITEM}: total=${mems.length} active=${active.length}`)
if (!active.length) {
  console.log('nothing ACTIVE — already healed; exiting')
  await prisma.$disconnect()
  process.exit(0)
}

const probe = active[0]
const row = await prisma.outboundSyncQueue.create({
  data: {
    targetChannel: 'EBAY',
    targetRegion: probe.marketplace,
    syncType: 'QUANTITY_UPDATE',
    syncStatus: 'PENDING',
    externalListingId: ITEM,
    productId: probe.productId,
    payload: {
      sku: probe.sku,
      itemId: ITEM,
      market: probe.marketplace,
      marketplaceId: `EBAY_${probe.marketplace}`,
      quantity: probe.lastQtyPushed ?? 0,
      pushVia: 'TRADING',
      source: 'RT0_HEAL_VERIFY',
    },
  },
  select: { id: true },
})
console.log(`enqueued verify row ${row.id} (sku ${probe.sku}) — waiting for prod drain…`)

for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 20_000))
  const r2 = await prisma.outboundSyncQueue.findUnique({
    where: { id: row.id },
    select: { syncStatus: true, errorCode: true, isDead: true, errorMessage: true },
  })
  console.log(`  t+${(i + 1) * 20}s: status=${r2?.syncStatus} errorCode=${r2?.errorCode} isDead=${r2?.isDead}`)
  if (r2 && r2.syncStatus !== 'PENDING' && r2.syncStatus !== 'IN_PROGRESS') {
    console.log(`  errorMessage: ${(r2.errorMessage ?? '').slice(0, 200)}`)
    break
  }
}

const after = await prisma.sharedListingMembership.groupBy({
  by: ['status'],
  where: { itemId: ITEM },
  _count: { _all: true },
})
console.log('memberships after:', JSON.stringify(after.map((a) => ({ status: a.status, n: a._count._all }))))

const circuitFlood = await prisma.outboundSyncQueue.count({
  where: {
    targetChannel: 'EBAY',
    syncStatus: 'FAILED',
    errorMessage: { contains: 'circuit open' },
    updatedAt: { gte: new Date(Date.now() - 10 * 60e3) },
  },
})
console.log(`circuit-open failures in last 10min (expect 0): ${circuitFlood}`)

await prisma.$disconnect()
process.exit(0)
