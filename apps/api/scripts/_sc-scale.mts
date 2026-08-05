/** READ-ONLY: readback coverage scale. */
const { default: prisma } = await import('../src/db.js')
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE', followPool: true },
  select: { itemId: true, marketplace: true, productId: true },
})
const items = new Set(mems.map((m) => `${m.marketplace}:${m.itemId}`))
const prods = new Set(mems.map((m) => m.productId).filter(Boolean))
console.log(`ACTIVE followPool memberships=${mems.length} distinctItems=${items.size} distinctProducts=${prods.size}`)
const mm = await prisma.syncHealthLog.groupBy({
  by: ['productId'],
  where: { conflictType: 'CHANNEL_QTY_READBACK', channel: 'EBAY', resolutionStatus: 'UNRESOLVED' },
})
console.log(`UNRESOLVED eBay readback products (all time) = ${mm.length}`)
await prisma.$disconnect()
