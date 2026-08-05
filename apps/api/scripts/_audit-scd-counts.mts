/* READ-ONLY audit probe: SCD grouping count/label semantics. */
const { default: prisma } = await import('../src/db.js')

// ---- replicate computeRows() row identity (productId only; no qty math) ----
const [listings, memberships] = await Promise.all([
  prisma.channelListing.findMany({
    where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: { productId: true, channel: true, marketplace: true, externalListingId: true, product: { select: { sku: true } } },
  }),
  prisma.sharedListingMembership.findMany({
    where: { status: 'ACTIVE' },
    select: { sku: true, itemId: true, marketplace: true, productId: true },
  }),
])

type R = { lane: 'LISTING' | 'SHARED'; sku: string; productId: string | null; channel: string; marketplace: string }
const rows: R[] = [
  ...listings.map((l) => ({ lane: 'LISTING' as const, sku: l.product?.sku ?? '?', productId: l.productId, channel: l.channel, marketplace: l.marketplace })),
  ...memberships.map((m) => ({ lane: 'SHARED' as const, sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace })),
]

const rowPids = [...new Set(rows.map((r) => r.productId).filter((p): p is string => Boolean(p)))]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true, sku: true } })
const pinfo = new Map(rowProducts.map((p) => [p.id, p]))
const masterOf = new Map(rowProducts.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]

// ---- replicate resolveCanonicalMasters ----
function canonicalStem(sku: string): string {
  let s = sku.trim()
  s = s.replace(/^(IT|DE|FR|ES|UK|EU)-/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA)$/i, '')
  return s.toUpperCase()
}
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
const canonicalOf = new Map<string, string>()
for (const mid of masterIds) {
  if (mastersWithChildren.has(mid)) { canonicalOf.set(mid, mid); continue }
  let resolved = mid
  for (const itemId of itemIdsByMaster.get(mid) ?? []) {
    const c = canonicalMasterByItemId.get(itemId)
    if (c && c !== mid) { resolved = c; break }
  }
  if (resolved === mid) {
    const c = canonicalByStem.get(stemOfMaster.get(mid) ?? '\0')
    if (c && c !== mid) resolved = c
  }
  canonicalOf.set(mid, resolved)
}

const groupIdOf = (pid: string) => { const mid = masterOf.get(pid) ?? pid; return canonicalOf.get(mid) ?? mid }
const groupIds = [...new Set(masterIds.map((m) => canonicalOf.get(m) ?? m))]

// ---- pool ----
const levels = await prisma.stockLevel.findMany({ where: { productId: { in: rowPids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true } })
const poolMap = new Map<string, number>()
for (const l of levels) poolMap.set(l.productId, (poolMap.get(l.productId) ?? 0) + l.available)
const poolOf = (p: string) => poolMap.get(p) ?? 0

const byMaster = new Map<string, R[]>()
for (const r of rows) { if (!r.productId) continue; const g = groupIdOf(r.productId); const a = byMaster.get(g) ?? []; a.push(r); byMaster.set(g, a) }

// real children counts per canonical
const realChildren = await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { in: groupIds } }, _count: { _all: true } })
const realChildCount = new Map(realChildren.map((r) => [r.parentId!, r._count._all]))

console.log(`ROWS=${rows.length} masters=${masterIds.length} groups=${groupIds.length}`)
console.log('')
const report = groupIds.map((gid) => {
  const children = byMaster.get(gid) ?? []
  const variantPids = [...new Set(children.map((c) => c.productId).filter((p): p is string => Boolean(p)))]
  const masterLike = variantPids.filter((p) => !pinfo.get(p)?.parentId)
  const trueVariants = variantPids.filter((p) => pinfo.get(p)?.parentId)
  return {
    gid,
    sku: masterSkus.find((m) => m.id === gid)?.sku ?? '?',
    reported_variantCount: variantPids.length,
    true_variant_pids: trueVariants.length,
    master_pids_counted_as_variants: masterLike.length,
    masterLikeSkus: masterLike.map((p) => pinfo.get(p)?.sku),
    real_children_in_db: realChildCount.get(gid) ?? 0,
    reported_variantsInStock: variantPids.filter((p) => poolOf(p) > 0).length,
    true_variantsInStock: trueVariants.filter((p) => poolOf(p) > 0).length,
    masterLike_with_pool: masterLike.filter((p) => poolOf(p) > 0).map((p) => `${pinfo.get(p)?.sku}=${poolOf(p)}`),
    reported_poolTotal: variantPids.reduce((s, p) => s + poolOf(p), 0),
    true_poolTotal: trueVariants.reduce((s, p) => s + poolOf(p), 0),
    listingCount: children.length,
  }
})
for (const r of report.sort((a, b) => b.master_pids_counted_as_variants - a.master_pids_counted_as_variants)) {
  const flag = r.reported_variantCount !== r.true_variant_pids ? ' <<< INFLATED' : ''
  console.log(`${r.sku}${flag}`)
  console.log(`   reported: ${r.reported_variantCount} var · ${r.listingCount} lst | inStock ${r.reported_variantsInStock}/${r.reported_variantCount} | pool ${r.reported_poolTotal}`)
  console.log(`   truth   : ${r.true_variant_pids} real variant pids (db children=${r.real_children_in_db}) | inStock ${r.true_variantsInStock} | pool ${r.true_poolTotal}`)
  if (r.master_pids_counted_as_variants) console.log(`   master-pids counted as variants (${r.master_pids_counted_as_variants}): ${JSON.stringify(r.masterLikeSkus)}`)
  if (r.masterLike_with_pool.length) console.log(`   !! master-pids WITH POOL (inflate stock too): ${JSON.stringify(r.masterLike_with_pool)}`)
  console.log('')
}
await prisma.$disconnect()
