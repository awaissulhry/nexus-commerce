/** DIM6: does a FOLDED master id export correctly? Read-only. */
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const rowPids = [...new Set([...listings.map((l) => l.productId), ...mems.map((m) => m.productId).filter(Boolean) as string[]])]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]

// replicate resolveCanonicalMasters
const [withChildren, masterSkus] = await Promise.all([
  prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
  prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
])
const mastersWithChildren = new Set(withChildren.map((p) => p.parentId).filter(Boolean) as string[])
const childless = masterIds.filter((id) => !mastersWithChildren.has(id))
const stemOfMaster = new Map<string, string>()
const canonicalByStem = new Map<string, string>()
const ordered = [...masterSkus].sort((a, b) => {
  const [sa, sb] = [canonicalStem(a.sku), canonicalStem(b.sku)]
  const [ea, eb] = [a.sku.toUpperCase() === sa ? 0 : 1, b.sku.toUpperCase() === sb ? 0 : 1]
  return ea - eb || a.sku.localeCompare(b.sku)
})
for (const m of ordered) {
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
    const a = itemIdsByMaster.get(c.productId) ?? []; a.push(c.externalListingId); itemIdsByMaster.set(c.productId, a); allItemIds.add(c.externalListingId)
  }
  if (allItemIds.size) {
    const ms = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItemIds] } }, select: { itemId: true, productId: true } })
    const memPids = [...new Set(ms.map((m) => m.productId).filter(Boolean) as string[])]
    const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
    const mop = new Map(memProducts.map((p) => [p.id, p.parentId ?? p.id]))
    for (const m of ms) {
      if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue
      const c = mop.get(m.productId)
      if (c && mastersWithChildren.has(c)) canonicalMasterByItemId.set(m.itemId, c)
    }
  }
}
const canon = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
const folded = [...canon.entries()].filter(([mid, cid]) => mid !== cid)
console.log(`masters=${masterIds.length} groups=${new Set([...canon.values()]).size} folded=${folded.length}`)
const skuOf = new Map(masterSkus.map((m) => [m.id, m.sku]))
for (const [mid, cid] of folded.slice(0, 6)) console.log(`  folded ${skuOf.get(mid)} (${mid}) -> ${skuOf.get(cid)} (${cid})`)

// Now: /export?masterId=<folded id>  (filterExportRows scoping)
if (folded.length) {
  const [fid, cid] = folded[0]
  const scoped = rowPids.filter((pid) => (canon.get(masterOf.get(pid) ?? pid) ?? masterOf.get(pid) ?? pid) === fid)
  const scopedCanon = rowPids.filter((pid) => (canon.get(masterOf.get(pid) ?? pid) ?? masterOf.get(pid) ?? pid) === cid)
  console.log(`\n/export?masterId=${fid} (FOLDED id, page renders fine) -> ${scoped.length} products in scope`)
  console.log(`/export?masterId=${cid} (canonical)                     -> ${scopedCanon.length} products in scope`)
}
await prisma.$disconnect()
