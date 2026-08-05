const { default: prisma } = await import('../src/db.js')

// Replicate the row-producing product id set from computeRows()
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { productId: true, marketplace: true },
})
const rowPids = [...new Set([
  ...listings.map((l) => l.productId),
  ...mems.map((m) => m.productId).filter((p): p is string => Boolean(p)),
])]

const rowProducts = await prisma.product.findMany({
  where: { id: { in: rowPids } },
  select: { id: true, parentId: true, sku: true },
})
const masterOf = new Map(rowProducts.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]

const withChildren = await prisma.product.findMany({
  where: { parentId: { in: masterIds } },
  select: { parentId: true }, distinct: ['parentId'],
})
const mastersWithChildren = new Set(withChildren.map((p) => p.parentId!).filter(Boolean))

const skuById = new Map((await prisma.product.findMany({
  where: { id: { in: masterIds } }, select: { id: true, sku: true },
})).map((p) => [p.id, p.sku]))

const rowPidSet = new Set(rowPids)

console.log('masters total', masterIds.length, 'withChildren', mastersWithChildren.size)
console.log('=== canonical (child-owning) masters: does the master itself appear as a row pid? ===')
for (const mid of [...mastersWithChildren]) {
  const inRows = rowPidSet.has(mid)
  const ownListings = listings.filter((l) => l.productId === mid)
  const ownMems = mems.filter((m) => m.productId === mid)
  const kids = await prisma.product.count({ where: { parentId: mid } })
  const lvls = await prisma.stockLevel.findMany({
    where: { productId: mid, location: { type: 'WAREHOUSE' } },
    select: { available: true },
  })
  const ownPool = lvls.reduce((s, l) => s + l.available, 0)
  console.log(
    `${(skuById.get(mid) ?? mid).padEnd(34)} inRowPids=${inRows ? 'YES' : 'no '} ownListings=${ownListings.length} ownMems=${ownMems.length} children=${kids} ownWarehousePool=${ownPool}`,
  )
}
await prisma.$disconnect()
