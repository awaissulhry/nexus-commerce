import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// Replicate computeRows' pid universe (published, not ended listings + active memberships)
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true, product: { select: { sku: true, parentId: true } } },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true },
})

const rowPids = [...new Set([
  ...listings.map((l) => l.productId),
  ...memberships.map((m) => m.productId).filter((p): p is string => Boolean(p)),
])]

const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true, sku: true } })
const masterOf = new Map(rowProducts.map((p) => [p.id, p.parentId ?? p.id]))
const skuOf = new Map(rowProducts.map((p) => [p.id, p.sku]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]

// per master: does the master's OWN id appear in rowPids? via which lane?
const pidSet = new Set(rowPids)
const masterMeta = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true, name: true } })
const metaById = new Map(masterMeta.map((m) => [m.id, m]))

const childCount = new Map<string, number>()
const kids = await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { in: masterIds } }, _count: { _all: true } })
for (const k of kids) if (k.parentId) childCount.set(k.parentId, k._count._all)

console.log('=== masters whose OWN productId appears in the row universe ===')
for (const mid of masterIds) {
  const m = metaById.get(mid)
  const self = pidSet.has(mid)
  const kidsN = childCount.get(mid) ?? 0
  const selfListings = listings.filter((l) => l.productId === mid).map((l) => `${l.channel}:${l.marketplace}:${l.externalListingId ?? '-'}`)
  const selfMems = memberships.filter((x) => x.productId === mid).map((x) => `MEM ${x.marketplace}:${x.itemId}`)
  console.log(
    `${(m?.sku ?? mid).padEnd(26)} kids=${String(kidsN).padStart(3)} selfInRows=${self ? 'YES' : 'no '} selfRows=${selfListings.length + selfMems.length}`,
    self ? JSON.stringify([...selfListings, ...selfMems].slice(0, 6)) : '',
  )
}

// Also: WAREHOUSE stock on masters themselves
const masterStock = await prisma.stockLevel.findMany({
  where: { productId: { in: masterIds }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true },
})
console.log('\n=== WAREHOUSE stock rows on MASTER products ===', masterStock.length)
for (const s of masterStock) console.log(' ', metaById.get(s.productId)?.sku, s.available)

await prisma.$disconnect()
