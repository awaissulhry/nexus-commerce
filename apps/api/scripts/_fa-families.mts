/* READ-ONLY probe 2: replicate /products grouping + summarizeFamilies to expose family-key collisions */
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem, familyKeyOf } = await import('../src/services/sync-control-product-view.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true, product: { select: { sku: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true },
})

type R = { lane: 'LISTING' | 'SHARED'; sku: string; productId: string | null; channel: string; marketplace: string; itemId?: string; ext?: string | null }
const rows: R[] = []
for (const l of listings) rows.push({ lane: 'LISTING', sku: l.product?.sku ?? '?', productId: l.productId, channel: l.channel, marketplace: l.marketplace, ext: l.externalListingId })
for (const m of mems) rows.push({ lane: 'SHARED', sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace, itemId: m.itemId })

const rowPids = [...new Set(rows.map(r => r.productId).filter((p): p is string => Boolean(p)))]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map(p => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id)!))]

// resolveCanonicalMasters replica
const [withChildren, masterSkus] = await Promise.all([
  prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
  prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
])
const mastersWithChildren = new Set(withChildren.map(p => p.parentId!).filter(Boolean))
const childless = masterIds.filter(id => !mastersWithChildren.has(id))
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
  for (const c of cls) { const a = itemIdsByMaster.get(c.productId) ?? []; a.push(c.externalListingId!); itemIdsByMaster.set(c.productId, a); allItemIds.add(c.externalListingId!) }
  if (allItemIds.size) {
    const ms = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItemIds] } }, select: { itemId: true, productId: true } })
    const pids = [...new Set(ms.map(m => m.productId).filter((x): x is string => Boolean(x)))]
    const mp = await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, parentId: true } })
    const mo = new Map(mp.map(p => [p.id, p.parentId ?? p.id]))
    for (const m of ms) { if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue; const c = mo.get(m.productId); if (c && mastersWithChildren.has(c)) canonicalMasterByItemId.set(m.itemId, c) }
  }
}
const canonicalOf = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
const skuOfMaster = new Map(masterSkus.map(m => [m.id, m.sku]))

const byGroup = new Map<string, R[]>()
for (const r of rows) {
  if (!r.productId) continue
  const mid = masterOf.get(r.productId)!
  const gid = canonicalOf.get(mid) ?? mid
  const a = byGroup.get(gid) ?? []; a.push(r); byGroup.set(gid, a)
}

console.log('=== FAMILY KEY COLLISIONS per group ===')
for (const [gid, rs] of [...byGroup.entries()].sort((a, b) => (skuOfMaster.get(a[0]) ?? '').localeCompare(skuOfMaster.get(b[0]) ?? ''))) {
  const fams = new Map<string, { n: number; exts: Set<string>; skus: Set<string>; lanes: Set<string> }>()
  for (const r of rs) {
    const k = familyKeyOf(r as never)
    const f = fams.get(k) ?? { n: 0, exts: new Set<string>(), skus: new Set<string>(), lanes: new Set<string>() }
    f.n++; f.skus.add(r.sku); f.lanes.add(r.lane)
    if (r.ext) f.exts.add(r.ext)
    fams.set(k, f)
  }
  const collides = [...fams.entries()].filter(([, f]) => f.exts.size > 1)
  if (!collides.length) continue
  console.log(`\nGROUP ${skuOfMaster.get(gid)} (${gid})  rows=${rs.length} families=${fams.size}`)
  for (const [k, f] of fams) {
    const flag = f.exts.size > 1 ? '  <== COLLISION' : ''
    console.log(`   family "${k}" lanes=${[...f.lanes]} rows=${f.n} skus=${f.skus.size} distinctExternalListingIds=${f.exts.size}${flag}`)
    if (f.exts.size > 1) console.log(`       exts: ${[...f.exts].join(', ')}`)
  }
}

console.log('\n=== ownerSku label determinism (mixed parents behind one itemId) ===')
const memItemIds = [...new Set(mems.map(m => m.itemId))]
const owners = await prisma.channelListing.findMany({
  where: { externalListingId: { in: memItemIds } },
  select: { externalListingId: true, product: { select: { sku: true, parentId: true, parent: { select: { sku: true } } } } },
})
const labelsByItem = new Map<string, Set<string>>()
for (const o of owners) {
  const lbl = o.product?.parent?.sku ?? o.product?.sku ?? ''
  const s = labelsByItem.get(o.externalListingId!) ?? new Set<string>()
  s.add(lbl); labelsByItem.set(o.externalListingId!, s)
}
for (const [item, s] of labelsByItem) {
  if (s.size > 1) console.log(` itemId ${item} -> AMBIGUOUS ownerSku candidates: ${[...s].join(' | ')}`)
}
console.log('itemIds with >1 possible ownerSku label:', [...labelsByItem.values()].filter(s => s.size > 1).length, '/', labelsByItem.size)
const missing = memItemIds.filter(i => !labelsByItem.has(i))
console.log('membership itemIds with NO owning ChannelListing (ownerSku null):', missing.length, missing.slice(0, 10))

await prisma.$disconnect()
