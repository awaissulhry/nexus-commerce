const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')
const out = (k: string, v: unknown) => console.log('###', k, JSON.stringify(v, null, 1))

// re-implement resolveCanonicalMasters exactly (read-only copy)
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
    const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
    const allItemIds = new Set<string>()
    for (const c of cls) {
      if (!c.externalListingId) continue
      const arr = itemIdsByMaster.get(c.productId) ?? []
      arr.push(c.externalListingId); itemIdsByMaster.set(c.productId, arr); allItemIds.add(c.externalListingId)
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

// ── A) canonical divergence: /products input set vs /actions input set ──
const listings = await prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true } })
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const rowPids = [...new Set([...listings.map((l) => l.productId), ...mems.map((m) => m.productId).filter((x): x is string => Boolean(x))])]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map((p) => [p.id, p.parentId ?? p.id]))
const viewMasterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]
const canonView = await resolveCanonicalMasters(viewMasterIds)

const allMasters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true } })
const canonAct = await resolveCanonicalMasters(allMasters.map((m) => m.id))

const skuById = new Map(allMasters.map((m) => [m.id, m.sku]))
const diverged: any[] = []
for (const mid of viewMasterIds) {
  const v = canonView.get(mid) ?? mid
  const a = canonAct.get(mid) ?? mid
  if (v !== a) diverged.push({ master: skuById.get(mid) ?? mid, viewCanonical: skuById.get(v) ?? v, actionCanonical: skuById.get(a) ?? a })
}
out('A_canonicalDivergence', { viewMasters: viewMasterIds.length, allMasters: allMasters.length, divergedCount: diverged.length, diverged: diverged.slice(0, 20) })

// groups shown in the grid
const groupIds = [...new Set(viewMasterIds.map((m) => canonView.get(m) ?? m))]
out('A_groupCount', { groups: groupIds.length })

// ── B) per-group: EXCLUDE/INCLUDE with zero memberships → 400 'no targets' ──
const clAll = await prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true, channel: true, marketplace: true } })
const memAll = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true, itemId: true, marketplace: true, sku: true } })
const groupOfPid = (pid: string) => { const m = masterOf.get(pid) ?? pid; return canonView.get(m) ?? m }
const listingsByGroup = new Map<string, typeof clAll>()
const memsByGroup = new Map<string, typeof memAll>()
for (const c of clAll) { const g = groupOfPid(c.productId); const a = listingsByGroup.get(g) ?? []; a.push(c); listingsByGroup.set(g, a) }
for (const m of memAll) { if (!m.productId) continue; const g = groupOfPid(m.productId); const a = memsByGroup.get(g) ?? []; a.push(m); memsByGroup.set(g, a) }
const noMemGroups = groupIds.filter((g) => (memsByGroup.get(g) ?? []).length === 0)
const noListingGroups = groupIds.filter((g) => (listingsByGroup.get(g) ?? []).length === 0)
out('B_lanes', {
  groups: groupIds.length,
  groupsWithNoMemberships_EXCLUDE_INCLUDE_400: noMemGroups.length,
  sampleNoMem: noMemGroups.slice(0, 10).map((g) => skuById.get(g) ?? g),
  groupsWithNoListings: noListingGroups.length,
})

// ── C) all-FBA groups: PAUSE/ZERO_PIN → updated 0, skippedFba N (no error) ──
const fbaProducts = new Set((await prisma.product.findMany({ where: { fulfillmentMethod: 'FBA' }, select: { id: true } })).map((p) => p.id))
const clFull = await prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true, channel: true, marketplace: true, fulfillmentMethod: true } })
const weak = (c: any) => c.fulfillmentMethod === 'FBA' || (c.fulfillmentMethod == null && fbaProducts.has(c.productId)) || fbaProducts.has(c.productId)
const perGroup = groupIds.map((g) => {
  const ls = (listingsByGroup.get(g) ?? [])
  const full = clFull.filter((c) => groupOfPid(c.productId) === g)
  const blocked = full.filter(weak)
  return { sku: skuById.get(g) ?? g, listings: full.length, fbaBlocked: blocked.length, ebayBlocked: blocked.filter((b) => b.channel !== 'AMAZON').length, mems: (memsByGroup.get(g) ?? []).length }
})
out('C_perGroup', perGroup.sort((a, b) => b.ebayBlocked - a.ebayBlocked))

// ── D) FOLLOW/PIN/BUFFER cross-product over-reach for a full-group action ──
// server groups targets by channel, then queries productIds × markets.
const allClAny = await prisma.channelListing.findMany({ where: { listingStatus: { not: 'ENDED' } }, select: { id: true, productId: true, channel: true, marketplace: true, isPublished: true, listingStatus: true, product: { select: { sku: true } } } })
const overreach: any[] = []
for (const g of groupIds) {
  const targets = clFull.filter((c) => groupOfPid(c.productId) === g)
  const byChan = new Map<string, typeof targets>()
  for (const t of targets) { const a = byChan.get(t.channel) ?? []; a.push(t); byChan.set(t.channel, a) }
  for (const [chan, ts] of byChan) {
    const pids = new Set(ts.map((t) => t.productId))
    const mkts = new Set(ts.map((t) => t.marketplace))
    const tripleSet = new Set(ts.map((t) => `${t.productId}|${t.marketplace}`))
    const matched = allClAny.filter((c) => c.channel === chan && pids.has(c.productId) && mkts.has(c.marketplace))
    const extra = matched.filter((c) => !tripleSet.has(`${c.productId}|${c.marketplace}`))
    if (extra.length) overreach.push({ group: skuById.get(g) ?? g, channel: chan, targets: ts.length, extraWritten: extra.length, sample: extra.slice(0, 5).map((e) => ({ sku: e.product?.sku, mk: e.marketplace, pub: e.isPublished, st: e.listingStatus })) })
  }
}
out('D_followPinBuffer_overreach', { groupsAffected: overreach.length, total: overreach.reduce((s, o) => s + o.extraWritten, 0), rows: overreach.slice(0, 15) })

await prisma.$disconnect()
