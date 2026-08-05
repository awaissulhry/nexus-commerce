import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')

async function resolveCanonicalMasters(masterIds: string[]) {
  if (masterIds.length === 0) return new Map<string, string>()
  const [withChildren, masterSkus] = await Promise.all([
    prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
    prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
  ])
  const mastersWithChildren = new Set(withChildren.map((p) => p.parentId).filter((x): x is string => Boolean(x)))
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
  if (childless.length > 0) {
    const cls = await prisma.channelListing.findMany({
      where: { productId: { in: childless }, externalListingId: { not: null } },
      select: { productId: true, externalListingId: true },
    })
    const allItemIds = new Set<string>()
    for (const c of cls) {
      if (!c.externalListingId) continue
      const arr = itemIdsByMaster.get(c.productId) ?? []
      arr.push(c.externalListingId)
      itemIdsByMaster.set(c.productId, arr)
      allItemIds.add(c.externalListingId)
    }
    if (allItemIds.size > 0) {
      const mems = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItemIds] } }, select: { itemId: true, productId: true } })
      const memPids = [...new Set(mems.map((m) => m.productId).filter((x): x is string => Boolean(x)))]
      const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
      const masterOfProduct = new Map(memProducts.map((p) => [p.id, p.parentId ?? p.id]))
      for (const m of mems) {
        if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue
        const canonical = masterOfProduct.get(m.productId)
        if (canonical && mastersWithChildren.has(canonical)) canonicalMasterByItemId.set(m.itemId, canonical)
      }
    }
  }
  return resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
}

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, fulfillmentMethod: true, product: { select: { fulfillmentMethod: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true, itemId: true, sku: true, marketplace: true } })
const rowPids = [...new Set([...listings.map((l) => l.productId), ...mems.map((m) => m.productId).filter((x): x is string => Boolean(x))])]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true, sku: true } })
const masterOf = new Map(rowProducts.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]
const canon = await resolveCanonicalMasters(masterIds)
const gidOf = (pid: string) => { const mid = masterOf.get(pid) ?? pid; return canon.get(mid) ?? mid }

interface G { listings: number; fba: number; mems: number; channels: Set<string> }
const groups = new Map<string, G>()
const g = (id: string) => { let x = groups.get(id); if (!x) { x = { listings: 0, fba: 0, mems: 0, channels: new Set() }; groups.set(id, x) } return x }
for (const l of listings) {
  const x = g(gidOf(l.productId))
  x.listings++
  x.channels.add(l.channel)
  const isFba = l.fulfillmentMethod === 'FBA' || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA') || l.product?.fulfillmentMethod === 'FBA'
  if (isFba) x.fba++
}
for (const m of mems) { if (!m.productId) continue; const x = g(gidOf(m.productId)); x.mems++; x.channels.add('EBAY_SHARED') }

const meta = await prisma.product.findMany({ where: { id: { in: [...groups.keys()] } }, select: { id: true, sku: true, name: true } })
const metaById = new Map(meta.map((m) => [m.id, m]))
console.log('TOTAL GROUPS', groups.size)
for (const [gid, x] of [...groups.entries()].sort((a, b) => a[1].mems - b[1].mems)) {
  const m = metaById.get(gid)
  // grid selectable when NOT (listings>0 && all FBA). rollup.listings counts CHILD ROWS (listings+mems)
  const totalRows = x.listings + x.mems
  const allFba = totalRows > 0 && x.fba === totalRows
  console.log(
    `${x.mems === 0 ? 'NO-MEMS ' : '        '} mems=${String(x.mems).padStart(4)} lst=${String(x.listings).padStart(4)} fba=${String(x.fba).padStart(4)} selectable=${!allFba} ch=${[...x.channels].join('/')} :: ${m?.sku ?? gid} — ${(m?.name ?? '').slice(0, 40)}`,
  )
}
await prisma.$disconnect()
