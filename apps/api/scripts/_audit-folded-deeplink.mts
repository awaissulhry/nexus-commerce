import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// Which masters would have been FOLDED, and would the pre-SCD UI ever have
// rendered a deep link (/product/<id>) for them? Deep link required
// childrenOmitted === true  <=>  variantCount > 20.
const listings = await prisma.channelListing.findMany({
  where: { listingStatus: { not: 'ENDED' } },
  select: { productId: true },
})
const pids = [...new Set(listings.map((l) => l.productId).filter((v): v is string => !!v))]
const prods = await prisma.product.findMany({
  where: { id: { in: pids } },
  select: { id: true, sku: true, parentId: true },
})
const masterOf = new Map(prods.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(pids.map((id) => masterOf.get(id) ?? id))]

const kids = await prisma.product.groupBy({
  by: ['parentId'],
  where: { parentId: { in: masterIds } },
  _count: { _all: true },
})
const childCount = new Map(kids.map((k) => [k.parentId as string, k._count._all]))

// pre-SCD bucket: distinct productIds among listing rows whose masterOf == mid
const bucket = new Map<string, Set<string>>()
for (const pid of pids) {
  const mid = masterOf.get(pid) ?? pid
  const s = bucket.get(mid) ?? new Set<string>()
  s.add(pid)
  bucket.set(mid, s)
}
const childless = masterIds.filter((m) => !childCount.get(m))
const skuOf = new Map(prods.map((p) => [p.id, p.sku]))
console.log('masters:', masterIds.length, 'childless (fold candidates):', childless.length)
let anyDeepLinkable = 0
for (const m of childless) {
  const vc = bucket.get(m)?.size ?? 0
  if (vc > 20) anyDeepLinkable++
  console.log(`  childless ${skuOf.get(m) ?? m}  preSCD variantCount=${vc}  deepLinkRendered=${vc > 20}`)
}
console.log('childless masters that pre-SCD showed an Open-arrow deep link:', anyDeepLinkable)
await prisma.$disconnect()
