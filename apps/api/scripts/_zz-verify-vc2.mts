import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem, omitChildrenInList, BIG_FAMILY_VARIANT_THRESHOLD } = await import('../src/services/sync-control-product-view.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true },
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

// resolveCanonicalMasters replication
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })
const mastersWithChildren = new Set(withChildren.map((p) => p.parentId!).filter(Boolean))
const childless = masterIds.filter((id) => !mastersWithChildren.has(id))
const stemOfMaster = new Map<string, string>()
const canonicalByStem = new Map<string, string>()
const orderedMasters = [...masterSkus].sort((a, b) => {
  const [sa, sb] = [canonicalStem(a.sku), canonicalStem(b.sku)]
  const [ea, eb] = [a.sku.toUpperCase() === sa ? 0 : 1, b.sku.toUpperCase() === sb ? 0 : 1]
  return ea - eb || a.sku.localeCompare(b.sku)
})
for (const m of orderedMasters) {
  const stem = canonicalStem(m.sku)
  stemOfMaster.set(m.id, stem)
  if (mastersWithChildren.has(m.id) && !canonicalByStem.has(stem)) canonicalByStem.set(stem, m.id)
}
const itemIdsByMaster = new Map<string, string[]>()
const canonicalMasterByItemId = new Map<string, string>()
if (childless.length) {
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
  const allItemIds = new Set<string>()
  for (const c of cls) { if (!c.externalListingId) continue; const a = itemIdsByMaster.get(c.productId) ?? []; a.push(c.externalListingId); itemIdsByMaster.set(c.productId, a); allItemIds.add(c.externalListingId) }
  if (allItemIds.size) {
    const mems = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItemIds] } }, select: { itemId: true, productId: true } })
    const memPids = [...new Set(mems.map((m) => m.productId).filter((x): x is string => Boolean(x)))]
    const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
    const masterOfProduct = new Map(memProducts.map((p) => [p.id, p.parentId ?? p.id]))
    for (const m of mems) { if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue; const c = masterOfProduct.get(m.productId); if (c && mastersWithChildren.has(c)) canonicalMasterByItemId.set(m.itemId, c) }
  }
}
const canonicalOf = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
const groupIdOf = (pid: string) => { const mid = masterOf.get(pid) ?? pid; return canonicalOf.get(mid) ?? mid }
const groupIds = [...new Set(masterIds.map((m) => canonicalOf.get(m) ?? m))]
const membersByGroup = new Map<string, string[]>()
for (const mid of masterIds) { const gid = canonicalOf.get(mid) ?? mid; if (gid !== mid) { const a = membersByGroup.get(gid) ?? []; a.push(mid); membersByGroup.set(gid, a) } }

const levels = await prisma.stockLevel.findMany({ where: { productId: { in: rowPids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true } })
const poolOf = (pid: string) => levels.filter((l) => l.productId === pid).reduce((s, l) => s + l.available, 0)

type Row = { productId: string | null }
const rows: Row[] = [
  ...listings.map((l) => ({ productId: l.productId })),
  ...memberships.map((m) => ({ productId: m.productId })),
]
const byMaster = new Map<string, Row[]>()
for (const r of rows) { if (!r.productId) continue; const g = groupIdOf(r.productId); const a = byMaster.get(g) ?? []; a.push(r); byMaster.set(g, a) }

const kids = await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { in: masterIds } }, _count: { _all: true } })
const kidCount = new Map<string, number>()
for (const k of kids) if (k.parentId) kidCount.set(k.parentId, k._count._all)
const metaById = new Map(masterSkus.map((m) => [m.id, m.sku]))

console.log('sku'.padEnd(24), 'lst'.padStart(4), 'vcSHOWN'.padStart(8), 'vcFIXED'.padStart(8), 'dbKids'.padStart(7), 'inStock'.padStart(8), 'selfIn'.padStart(7), 'truncSHOWN'.padStart(11), 'truncFIXED'.padStart(11))
for (const mid of groupIds) {
  const children = byMaster.get(mid) ?? []
  const allPids = [...new Set(children.map((c) => c.productId).filter((p): p is string => Boolean(p)))]
  const folded = new Set(membersByGroup.get(mid) ?? [])
  const shown = allPids.filter((p) => !folded.has(p))
  const fixed = shown.filter((p) => p !== mid)
  const inStockShown = shown.filter((p) => poolOf(p) > 0).length
  const inStockFixed = fixed.filter((p) => poolOf(p) > 0).length
  console.log(
    (metaById.get(mid) ?? mid).padEnd(24),
    String(children.length).padStart(4),
    String(shown.length).padStart(8),
    String(fixed.length).padStart(8),
    String(kidCount.get(mid) ?? 0).padStart(7),
    `${inStockShown}/${shown.length} -> ${inStockFixed}/${fixed.length}`.padStart(8),
    String(allPids.includes(mid)).padStart(7),
    String(omitChildrenInList(shown.length)).padStart(11),
    String(omitChildrenInList(fixed.length)).padStart(11),
  )
}
console.log('threshold', BIG_FAMILY_VARIANT_THRESHOLD)
await prisma.$disconnect()
