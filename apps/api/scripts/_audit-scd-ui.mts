/** READ-ONLY audit probe: group rollup shape for the Sync Control products grid.
 *  Reports per group: distinct modes (Sync column width risk), variantCount as
 *  the endpoint computes it vs the canonical's REAL child count. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true, product: { select: { sku: true } } },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true },
})

const rows: Array<{ pid: string; lane: string }> = []
for (const l of listings) rows.push({ pid: l.productId, lane: 'LISTING' })
for (const m of memberships) if (m.productId) rows.push({ pid: m.productId, lane: 'SHARED' })

const rowPids = [...new Set(rows.map((r) => r.pid))]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rowProducts.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]

// replicate resolveCanonicalMasters()
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })
const mastersWithChildren = new Set(withChildren.map((p) => p.parentId!).filter(Boolean))
const childless = masterIds.filter((id) => !mastersWithChildren.has(id))
const stemOfMaster = new Map<string, string>()
const canonicalByStem = new Map<string, string>()
for (const m of masterSkus) {
  const stem = canonicalStem(m.sku)
  stemOfMaster.set(m.id, stem)
  if (mastersWithChildren.has(m.id) && !canonicalByStem.has(stem)) canonicalByStem.set(stem, m.id)
}
const itemIdsByMaster = new Map<string, string[]>()
const canonicalMasterByItemId = new Map<string, string>()
if (childless.length) {
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
  const allItemIds = new Set<string>()
  for (const c of cls) {
    if (!c.externalListingId) continue
    const arr = itemIdsByMaster.get(c.productId) ?? []
    arr.push(c.externalListingId); itemIdsByMaster.set(c.productId, arr); allItemIds.add(c.externalListingId)
  }
  if (allItemIds.size) {
    const mems = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItemIds] } }, select: { itemId: true, productId: true } })
    const memPids = [...new Set(mems.map((m) => m.productId!).filter(Boolean))]
    const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
    const masterOfProduct = new Map(memProducts.map((p) => [p.id, p.parentId ?? p.id]))
    for (const m of mems) {
      if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue
      const canonical = masterOfProduct.get(m.productId)
      if (canonical && mastersWithChildren.has(canonical)) canonicalMasterByItemId.set(m.itemId, canonical)
    }
  }
}
const canonicalOf = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
const groupIdOf = (pid: string) => canonicalOf.get(masterOf.get(pid) ?? pid) ?? masterOf.get(pid) ?? pid

const byGroup = new Map<string, Set<string>>()
for (const r of rows) {
  const g = groupIdOf(r.pid)
  const s = byGroup.get(g) ?? new Set<string>(); s.add(r.pid); byGroup.set(g, s)
}
const groupIds = [...byGroup.keys()]
const meta = await prisma.product.findMany({ where: { id: { in: groupIds } }, select: { id: true, sku: true, name: true } })
const metaById = new Map(meta.map((m) => [m.id, m]))
const realChildren = await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { in: groupIds } }, _count: { _all: true } })
const realChildCount = new Map(realChildren.map((r) => [r.parentId!, r._count._all]))

console.log('GROUPS:', groupIds.length, 'from masters:', masterIds.length)
console.log('sku | variantCount(endpoint) | realChildren | inflation | nonVariantPids')
for (const g of groupIds) {
  const pids = byGroup.get(g)!
  const vc = pids.size
  const rc = realChildCount.get(g) ?? 0
  // pids that are NOT children of the canonical (i.e. masters/dupe shells)
  const nonVariant = [...pids].filter((p) => (masterOf.get(p) ?? p) === p)
  if (vc !== rc) {
    const nvSkus = await prisma.product.findMany({ where: { id: { in: nonVariant } }, select: { sku: true } })
    console.log(`${metaById.get(g)?.sku ?? g} | ${vc} | ${rc} | ${vc - rc} | ${nvSkus.map((x) => x.sku).join(', ')}`)
  }
}
await prisma.$disconnect()
