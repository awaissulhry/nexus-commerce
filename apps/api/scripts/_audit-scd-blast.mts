import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true },
})
const rowPids = [...new Set([
  ...listings.map(l => l.productId),
  ...mems.map(m => m.productId).filter((p): p is string => !!p),
])]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true, sku: true } })
const masterOf = new Map(rowProducts.map(p => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id) ?? id))]
console.log('LISTING rows', listings.length, 'SHARED rows', mems.length, 'rowPids', rowPids.length, 'masters', masterIds.length)

// replicate resolveCanonicalMasters
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true, name: true } })
const skuOf = new Map(masterSkus.map(m => [m.id, m.sku]))
const mastersWithChildren = new Set(withChildren.map(p => p.parentId!).filter(Boolean))
const childless = masterIds.filter(id => !mastersWithChildren.has(id))
const stem = (sku: string) => sku.trim().replace(/^(IT|DE|FR|ES|UK|EU)-/i, '').replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '').replace(/-(ALT\d*|FBM|FBA)$/i, '').toUpperCase()
const stemOfMaster = new Map<string, string>()
const canonicalByStem = new Map<string, string>()
for (const m of masterSkus) {
  const s = stem(m.sku); stemOfMaster.set(m.id, s)
  if (mastersWithChildren.has(m.id) && !canonicalByStem.has(s)) canonicalByStem.set(s, m.id)
}
const itemIdsByMaster = new Map<string, string[]>()
const canonicalMasterByItemId = new Map<string, string>()
if (childless.length) {
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
  const all = new Set<string>()
  for (const c of cls) { if (!c.externalListingId) continue; const a = itemIdsByMaster.get(c.productId) ?? []; a.push(c.externalListingId); itemIdsByMaster.set(c.productId, a); all.add(c.externalListingId) }
  if (all.size) {
    const ms = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...all] } }, select: { itemId: true, productId: true } })
    const pids = [...new Set(ms.map(m => m.productId).filter((x): x is string => !!x))]
    const mp = await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, parentId: true } })
    const mo = new Map(mp.map(p => [p.id, p.parentId ?? p.id]))
    for (const m of ms) { if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue; const c = mo.get(m.productId); if (c && mastersWithChildren.has(c)) canonicalMasterByItemId.set(m.itemId, c) }
  }
}
const canonicalOf = new Map<string, string>()
for (const mid of masterIds) {
  if (mastersWithChildren.has(mid)) { canonicalOf.set(mid, mid); continue }
  let resolved = mid
  for (const it of itemIdsByMaster.get(mid) ?? []) { const c = canonicalMasterByItemId.get(it); if (c && c !== mid) { resolved = c; break } }
  if (resolved === mid) { const c = canonicalByStem.get(stemOfMaster.get(mid) ?? '\0'); if (c && c !== mid) resolved = c }
  canonicalOf.set(mid, resolved)
}
const groupIds = [...new Set(masterIds.map(m => canonicalOf.get(m) ?? m))]
console.log('groups', groupIds.length)
const membersByGroup = new Map<string, string[]>()
for (const mid of masterIds) { const g = canonicalOf.get(mid)!; if (g !== mid) { const a = membersByGroup.get(g) ?? []; a.push(mid); membersByGroup.set(g, a) } }
for (const [g, ms] of membersByGroup) console.log('GROUP', skuOf.get(g), '<-', ms.map(m => skuOf.get(m)).join(', '))

// per-group variantCount vs true variant count of canonical
const groupIdOf = (pid: string) => canonicalOf.get(masterOf.get(pid) ?? pid) ?? pid
const pidsByGroup = new Map<string, Set<string>>()
for (const l of listings) { const g = groupIdOf(l.productId); const s = pidsByGroup.get(g) ?? new Set(); s.add(l.productId); pidsByGroup.set(g, s) }
for (const m of mems) { if (!m.productId) continue; const g = groupIdOf(m.productId); const s = pidsByGroup.get(g) ?? new Set(); s.add(m.productId); pidsByGroup.set(g, s) }
const realChildCounts = await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { in: groupIds } }, _count: true })
const realKids = new Map(realChildCounts.map(r => [r.parentId!, r._count]))
console.log('\n--- variantCount inflation (group pids includes duplicate MASTER products themselves) ---')
for (const g of groupIds) {
  const pids = [...(pidsByGroup.get(g) ?? [])]
  const masterProductsInside = pids.filter(p => masterIds.includes(masterOf.get(p) ?? p) && (masterOf.get(p) ?? p) === p)
  if (masterProductsInside.length > 0) {
    console.log(skuOf.get(g), 'variantCount=', pids.length, 'realChildren=', realKids.get(g) ?? 0, 'masterProductsCountedAsVariants=', masterProductsInside.map(p => skuOf.get(p) ?? p).join(','))
  }
}

// stock on member master products (poolTotal contribution)
const memberIds = [...membersByGroup.values()].flat()
if (memberIds.length) {
  const lv = await prisma.stockLevel.findMany({ where: { productId: { in: memberIds }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true } })
  console.log('\nstock levels on folded member MASTER products:', lv.length, lv.map(l => `${skuOf.get(l.productId)}=${l.available}`).join(' '))
}
await prisma.$disconnect()
