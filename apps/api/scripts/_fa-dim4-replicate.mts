const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem, omitChildrenInList, INLINE_PREVIEW_ROWS } = await import('../src/services/sync-control-product-view.js')

// --- replicate computeRows productId/lane/sku/channel/market/itemId only ---
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true, product: { select: { sku: true } } },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true },
})
type R = { lane: string; sku: string; productId: string | null; channel: string; marketplace: string; itemId?: string }
const rows: R[] = []
for (const l of listings) rows.push({ lane: 'LISTING', sku: l.product?.sku ?? '?', productId: l.productId, channel: l.channel, marketplace: l.marketplace })
for (const m of memberships) rows.push({ lane: 'SHARED', sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace, itemId: m.itemId })

const rowPids = [...new Set(rows.map((r) => r.productId).filter((p): p is string => Boolean(p)))]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]

// replicate resolveCanonicalMasters
const [withChildren, masterSkus] = await Promise.all([
  prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
  prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
])
const mastersWithChildren = new Set(withChildren.map((p) => p.parentId!).filter(Boolean))
const childless = masterIds.filter((id) => !mastersWithChildren.has(id))
const stemOfMaster = new Map<string, string>(); const canonicalByStem = new Map<string, string>()
const ordered = [...masterSkus].sort((a, b) => {
  const [sa, sb] = [canonicalStem(a.sku), canonicalStem(b.sku)]
  const [ea, eb] = [a.sku.toUpperCase() === sa ? 0 : 1, b.sku.toUpperCase() === sb ? 0 : 1]
  return ea - eb || a.sku.localeCompare(b.sku)
})
for (const m of ordered) { const s = canonicalStem(m.sku); stemOfMaster.set(m.id, s); if (mastersWithChildren.has(m.id) && !canonicalByStem.has(s)) canonicalByStem.set(s, m.id) }
const itemIdsByMaster = new Map<string, string[]>(); const canonicalMasterByItemId = new Map<string, string>()
if (childless.length) {
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
  const all = new Set<string>()
  for (const c of cls) { if (!c.externalListingId) continue; const a = itemIdsByMaster.get(c.productId) ?? []; a.push(c.externalListingId); itemIdsByMaster.set(c.productId, a); all.add(c.externalListingId) }
  if (all.size) {
    const mems = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...all] } }, select: { itemId: true, productId: true } })
    const pids = [...new Set(mems.map((m) => m.productId).filter((x): x is string => Boolean(x)))]
    const mp = await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, parentId: true } })
    const mo = new Map(mp.map((p) => [p.id, p.parentId ?? p.id]))
    for (const m of mems) { if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue; const c = mo.get(m.productId); if (c && mastersWithChildren.has(c)) canonicalMasterByItemId.set(m.itemId, c) }
  }
}
const canonicalOf = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
const groupIds = [...new Set(masterIds.map((m) => canonicalOf.get(m) ?? m))]
const membersByGroup = new Map<string, string[]>()
for (const mid of masterIds) { const gid = canonicalOf.get(mid) ?? mid; if (gid !== mid) { const a = membersByGroup.get(gid) ?? []; a.push(mid); membersByGroup.set(gid, a) } }
const groupIdOf = (pid: string) => { const mid = masterOf.get(pid) ?? pid; return canonicalOf.get(mid) ?? mid }
const byMaster = new Map<string, R[]>()
for (const r of rows) { if (!r.productId) continue; const g = groupIdOf(r.productId); const a = byMaster.get(g) ?? []; a.push(r); byMaster.set(g, a) }
const skuById = new Map(masterSkus.map((m) => [m.id, m.sku]))
const realChildCount = new Map<string, number>()
for (const g of groupIds) realChildCount.set(g, await prisma.product.count({ where: { parentId: g } }))

const out: any[] = []
for (const gid of groupIds) {
  const children = (byMaster.get(gid) ?? []).slice().sort((a, b) => a.sku.localeCompare(b.sku) || a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace) || (a.itemId ?? '').localeCompare(b.itemId ?? ''))
  const allPids = [...new Set(children.map((c) => c.productId).filter((p): p is string => Boolean(p)))]
  const folded = new Set(membersByGroup.get(gid) ?? [])
  const variantPids = allPids.filter((p) => !folded.has(p))
  const includesSelf = variantPids.includes(gid)
  const truncated = omitChildrenInList(variantPids.length)
  out.push({
    sku: skuById.get(gid), listingCount: children.length, variantCount_SHOWN: variantPids.length,
    realDbChildren: realChildCount.get(gid), listedRealVariants: variantPids.filter((p) => p !== gid).length,
    selfCounted: includesSelf, truncated, previewShown: truncated ? Math.min(children.length, INLINE_PREVIEW_ROWS) : children.length,
    foldedMasters: (membersByGroup.get(gid) ?? []).length,
  })
}
out.sort((a, b) => b.listingCount - a.listingCount)
console.table(out)

// preview composition for the biggest family
const big = out[0]
const gid = groupIds.find((g) => skuById.get(g) === big.sku)!
const ch = (byMaster.get(gid) ?? []).slice().sort((a, b) => a.sku.localeCompare(b.sku) || a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace) || (a.itemId ?? '').localeCompare(b.itemId ?? ''))
console.log(`\nPREVIEW SLICE (first 12) for ${big.sku} — ${ch.length} total rows:`)
for (const r of ch.slice(0, 12)) console.log(`  ${r.lane}  ${r.sku}  ${r.channel}:${r.marketplace}  ${r.itemId ?? ''}`)
console.log('distinct SKUs in preview:', new Set(ch.slice(0, 12).map((r) => r.sku)).size, 'of', new Set(ch.map((r) => r.sku)).size)

await prisma.$disconnect()
