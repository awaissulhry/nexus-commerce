import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

function canonicalStem(sku: string): string {
  let s = sku.trim()
  s = s.replace(/^(IT|DE|FR|ES|UK|EU)-/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA)$/i, '')
  return s.toUpperCase()
}

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true },
})
const memsActive = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' }, select: { productId: true, itemId: true, sku: true, marketplace: true },
})
const rowPids = [...new Set([...listings.map(l => l.productId), ...memsActive.map(m => m.productId).filter(Boolean) as string[]])]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true, sku: true } })
const masterOf = new Map(rowProducts.map(p => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id) ?? id))]
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const mastersWithChildren = new Set(withChildren.map(p => p.parentId!).filter(Boolean))
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true, name: true } })
const skuById = new Map(masterSkus.map(m => [m.id, m.sku]))
const childless = masterIds.filter(id => !mastersWithChildren.has(id))

// replicate server resolution
const stemOfMaster = new Map<string, string>(); const canonicalByStem = new Map<string, string>()
const ordered = [...masterSkus].sort((a, b) => {
  const [sa, sb] = [canonicalStem(a.sku), canonicalStem(b.sku)]
  const [ea, eb] = [a.sku.toUpperCase() === sa ? 0 : 1, b.sku.toUpperCase() === sb ? 0 : 1]
  return ea - eb || a.sku.localeCompare(b.sku)
})
for (const m of ordered) {
  const s = canonicalStem(m.sku); stemOfMaster.set(m.id, s)
  if (mastersWithChildren.has(m.id) && !canonicalByStem.has(s)) canonicalByStem.set(s, m.id)
}
const itemIdsByMaster = new Map<string, string[]>(); const canonicalMasterByItemId = new Map<string, string>()
const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const allItemIds = new Set<string>()
for (const c of cls) { itemIdsByMaster.set(c.productId, [...(itemIdsByMaster.get(c.productId) ?? []), c.externalListingId!]); allItemIds.add(c.externalListingId!) }
const ms = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItemIds] } }, select: { itemId: true, productId: true } })
const memProducts = await prisma.product.findMany({ where: { id: { in: [...new Set(ms.map(m => m.productId).filter(Boolean) as string[])] } }, select: { id: true, parentId: true } })
const masterOfProduct = new Map(memProducts.map(p => [p.id, p.parentId ?? p.id]))
for (const m of ms) {
  if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue
  const c = masterOfProduct.get(m.productId)
  if (c && mastersWithChildren.has(c)) canonicalMasterByItemId.set(m.itemId, c)
}
const canonicalOf = new Map<string, string>()
for (const mid of masterIds) {
  if (mastersWithChildren.has(mid)) { canonicalOf.set(mid, mid); continue }
  let r = mid
  for (const it of itemIdsByMaster.get(mid) ?? []) { const c = canonicalMasterByItemId.get(it); if (c && c !== mid) { r = c; break } }
  if (r === mid) { const c = canonicalByStem.get(stemOfMaster.get(mid) ?? '\0'); if (c && c !== mid) r = c }
  canonicalOf.set(mid, r)
}
const groupIdOf = (pid: string) => { const mid = masterOf.get(pid) ?? pid; return canonicalOf.get(mid) ?? mid }

// ===== KEY TEST: does one physical eBay itemId appear under >1 GROUP? =====
const groupsByItem = new Map<string, Set<string>>()
const detailByItem = new Map<string, string[]>()
for (const l of listings) {
  if (!l.externalListingId || l.channel !== 'EBAY') continue
  const g = groupIdOf(l.productId)
  const s = groupsByItem.get(l.externalListingId) ?? new Set<string>(); s.add(g); groupsByItem.set(l.externalListingId, s)
  detailByItem.set(l.externalListingId, [...(detailByItem.get(l.externalListingId) ?? []), `LISTING ${rowProducts.find(p=>p.id===l.productId)?.sku}`])
}
for (const m of memsActive) {
  if (!m.productId) continue
  const g = groupIdOf(m.productId)
  const s = groupsByItem.get(m.itemId) ?? new Set<string>(); s.add(g); groupsByItem.set(m.itemId, s)
  detailByItem.set(m.itemId, [...(detailByItem.get(m.itemId) ?? []), `MEMBER ${m.sku}`])
}
console.log('=== KEY: eBay itemIds appearing under MORE THAN ONE group row ===')
let bad = 0
for (const [it, gs] of groupsByItem) {
  if (gs.size > 1) {
    bad++
    console.log('  itemId', it, 'appears in groups:', [...gs].map(g => skuById.get(g) ?? g))
    console.log('     sources:', [...new Set(detailByItem.get(it) ?? [])].slice(0, 8))
  }
}
if (!bad) console.log('  (none — grouping is clean on this axis)')

// ===== per-group payload numbers =====
console.log('\n=== per-group payload (variantCount / poolTotal / listings rows) ===')
const membersByGroup = new Map<string, string[]>()
for (const mid of masterIds) { const g = canonicalOf.get(mid)!; if (g !== mid) membersByGroup.set(g, [...(membersByGroup.get(g) ?? []), mid]) }
const levels = await prisma.stockLevel.findMany({ where: { productId: { in: rowPids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true } })
const poolOf = new Map<string, number>()
for (const l of levels) poolOf.set(l.productId, (poolOf.get(l.productId) ?? 0) + l.available)

const rowsPerGroup = new Map<string, { pids: Set<string>; n: number }>()
const bump = (pid: string) => { const g = groupIdOf(pid); const e = rowsPerGroup.get(g) ?? { pids: new Set<string>(), n: 0 }; e.pids.add(pid); e.n++; rowsPerGroup.set(g, e) }
for (const l of listings) bump(l.productId)
for (const m of memsActive) if (m.productId) bump(m.productId)

const groupIds = [...new Set(masterIds.map(m => canonicalOf.get(m)!))]
for (const g of groupIds) {
  const e = rowsPerGroup.get(g) ?? { pids: new Set<string>(), n: 0 }
  const folded = new Set(membersByGroup.get(g) ?? [])
  const variantPids = [...e.pids].filter(p => !folded.has(p))
  const includesMasterItself = variantPids.includes(g)
  const pool = variantPids.reduce((s, p) => s + (poolOf.get(p) ?? 0), 0)
  console.log(
    (skuById.get(g) ?? g).padEnd(34),
    'rows=' + String(e.n).padStart(4),
    'variantCount=' + String(variantPids.length).padStart(3),
    'masterCountedAsVariant=' + (includesMasterItself ? 'YES' : 'no '),
    'poolTotal=' + pool,
    'omitChildren=' + (variantPids.length > 20),
  )
}

// real variant count from DB for comparison
console.log('\n=== DB truth: children per canonical master ===')
const kids = await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { in: groupIds } }, _count: true })
for (const k of kids) console.log('  ', skuById.get(k.parentId!), 'children in DB =', k._count)

await prisma.$disconnect()
