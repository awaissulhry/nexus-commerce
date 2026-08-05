const { default: prisma } = await import('../src/db.js')

const masters = await prisma.product.findMany({
  where: { parentId: null, sku: { contains: 'GALE' } },
  select: { id: true, sku: true, _count: { select: { children: true } } },
})
console.log('GALE masters:')
for (const m of masters) console.log(' ', m.sku, m.id, 'children=', m._count.children)

const canonical = masters.find((m) => m._count.children > 0)
if (!canonical) { console.log('no canonical'); process.exit(0) }
const members = masters.filter((m) => m._count.children === 0)

const kids = await prisma.product.findMany({ where: { parentId: canonical.id }, select: { id: true } })
const canonPids = [canonical.id, ...kids.map((k) => k.id)]

const canonCls = await prisma.channelListing.findMany({
  where: { productId: { in: canonPids }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { id: true, productId: true, channel: true, marketplace: true, externalListingId: true, syncPaused: true, quantity: true, followMasterQuantity: true },
})
console.log('\ncanonical-only listing lane rows:', canonCls.length)
const canonItems = new Set(canonCls.map((c) => c.externalListingId).filter(Boolean))
console.log('canonical listing itemIds:', [...canonItems].join(','))

const canonMems = await prisma.sharedListingMembership.findMany({
  where: { productId: { in: canonPids }, status: 'ACTIVE' },
  select: { itemId: true, marketplace: true, sku: true },
})
const memItems = new Set(canonMems.map((m) => m.itemId))
console.log('canonical membership itemIds:', [...memItems].join(','), '(rows', canonMems.length, ')')

for (const mem of members) {
  const mkids = await prisma.product.findMany({ where: { parentId: mem.id }, select: { id: true } })
  const pids = [mem.id, ...mkids.map((k) => k.id)]
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: { id: true, channel: true, marketplace: true, externalListingId: true, syncPaused: true, quantity: true, followMasterQuantity: true, fulfillmentMethod: true },
  })
  console.log(`\nMEMBER ${mem.sku}: ${cls.length} live listing rows`)
  for (const c of cls) {
    console.log(`   ${c.channel}/${c.marketplace} item=${c.externalListingId} qty=${c.quantity} paused=${c.syncPaused} follow=${c.followMasterQuantity} fm=${c.fulfillmentMethod} coveredByCanonListingLane=${canonCls.some((x) => x.id === c.id)} itemInCanonMemberships=${c.externalListingId ? memItems.has(c.externalListingId) : 'n/a'}`)
  }
}
await prisma.$disconnect()
