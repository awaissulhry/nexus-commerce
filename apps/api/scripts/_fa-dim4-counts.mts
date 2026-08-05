const { default: prisma } = await import('../src/db.js')

// Which masters (parentId=null) have BOTH children AND their own published listing rows?
const masters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true, name: true } })
const kids = await prisma.product.groupBy({ by: ['parentId'], _count: { _all: true }, where: { parentId: { not: null } } })
const kidCount = new Map(kids.map((k) => [k.parentId as string, k._count._all]))

const cls = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true },
})
const listingsByPid = new Map<string, number>()
for (const c of cls) listingsByPid.set(c.productId, (listingsByPid.get(c.productId) ?? 0) + 1)

const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { productId: true, itemId: true, sku: true },
})
const memsByPid = new Map<string, number>()
for (const m of mems) if (m.productId) memsByPid.set(m.productId, (memsByPid.get(m.productId) ?? 0) + 1)

const rows: any[] = []
for (const m of masters) {
  const kc = kidCount.get(m.id) ?? 0
  const ownListings = listingsByPid.get(m.id) ?? 0
  const ownMems = memsByPid.get(m.id) ?? 0
  if (kc > 0 && (ownListings > 0 || ownMems > 0)) {
    rows.push({ sku: m.sku, name: m.name.slice(0, 40), children: kc, ownListingRows: ownListings, ownMemRows: ownMems })
  }
}
console.log('MASTERS WITH CHILDREN THAT ALSO CARRY THEIR OWN LISTING ROWS:', rows.length)
console.table(rows)

// Per-group totals for a few named families
const NAMES = ['GALE', 'AIRMESH', 'AIREON', 'SLIDER', 'MOSS', 'VENTRA']
for (const n of NAMES) {
  const ms = masters.filter((m) => m.sku.toUpperCase().includes(n))
  if (!ms.length) continue
  console.log(`\n== ${n} ==`)
  for (const m of ms) {
    console.log(`  ${m.sku}  id=${m.id}  children=${kidCount.get(m.id) ?? 0}  ownListings=${listingsByPid.get(m.id) ?? 0}  ownMems=${memsByPid.get(m.id) ?? 0}`)
  }
}
await prisma.$disconnect()
