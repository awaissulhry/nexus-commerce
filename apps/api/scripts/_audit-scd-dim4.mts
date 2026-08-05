import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem, omitChildrenInList } = await import('../src/services/sync-control-product-view.js')

// ---- replicate computeRows() productId/lane/sku/channel/market skeleton ----
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

type R = { lane: 'LISTING' | 'SHARED'; sku: string; productId: string | null; channel: string; marketplace: string; itemId?: string }
const rows: R[] = []
for (const cl of listings) rows.push({ lane: 'LISTING', sku: cl.product?.sku ?? '?', productId: cl.productId, channel: cl.channel, marketplace: cl.marketplace })
for (const m of memberships) rows.push({ lane: 'SHARED', sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace, itemId: m.itemId })

const rowPids = [...new Set(rows.map(r => r.productId).filter((p): p is string => Boolean(p)))]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rowProducts.map(p => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id) ?? id))]

// ---- replicate resolveCanonicalMasters ----
const [withChildren, masterSkus] = await Promise.all([
  prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
  prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true, name: true } }),
])
const mastersWithChildren = new Set(withChildren.map(p => p.parentId).filter((x): x is string => Boolean(x)))
const childless = masterIds.filter(id => !mastersWithChildren.has(id))
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
    const memPids = [...new Set(mems.map(m => m.productId).filter((x): x is string => Boolean(x)))]
    const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
    const masterOfProduct = new Map(memProducts.map(p => [p.id, p.parentId ?? p.id]))
    for (const m of mems) {
      if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue
      const canonical = masterOfProduct.get(m.productId)
      if (canonical && mastersWithChildren.has(canonical)) canonicalMasterByItemId.set(m.itemId, canonical)
    }
  }
}
const canonicalOf = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
const groupIds = [...new Set(masterIds.map(m => canonicalOf.get(m) ?? m))]
const skuOf = new Map(masterSkus.map(m => [m.id, m.sku]))
const nameOf = new Map(masterSkus.map(m => [m.id, m.name]))

console.log(`RESULT masters=${masterIds.length} groups=${groupIds.length}`)

// ---- FOLDED masters (their id is no longer a valid ?masterId=) ----
const folded = masterIds.filter(m => (canonicalOf.get(m) ?? m) !== m)
console.log(`\nRESULT folded masters (${folded.length}) — /product/<id> now 404s:`)
for (const f of folded) console.log(`  FOLD ${f}  ${skuOf.get(f)}  ->  ${canonicalOf.get(f)} ${skuOf.get(canonicalOf.get(f)!)}`)

// ---- group sizing: variantCount vs children.length, childrenOmitted ----
const byGroup = new Map<string, R[]>()
for (const r of rows) {
  if (!r.productId) continue
  const gid = canonicalOf.get(masterOf.get(r.productId) ?? r.productId) ?? (masterOf.get(r.productId) ?? r.productId)
  const a = byGroup.get(gid) ?? []; a.push(r); byGroup.set(gid, a)
}
console.log('\nRESULT group sizes (variantCount | listings | omitted | sku):')
const sized = [...byGroup.entries()].map(([gid, rs]) => {
  const vpids = new Set(rs.map(r => r.productId!).filter(Boolean))
  return { gid, vc: vpids.size, n: rs.length, omitted: omitChildrenInList(vpids.size), sku: skuOf.get(gid), name: nameOf.get(gid), members: masterIds.filter(m => m !== gid && (canonicalOf.get(m) ?? m) === gid) }
}).sort((a, b) => b.n - a.n)
for (const s of sized) console.log(`  GRP vc=${s.vc} listings=${s.n} omitted=${s.omitted} members=${s.members.length} ${s.sku}`)

// ---- export shortfall: what GET /export?masterId=<gid> would return vs the detail grid ----
console.log('\nRESULT export shortfall per group (detail grid rows vs export rows):')
for (const s of sized) {
  const variants = await prisma.product.findMany({ where: { OR: [{ id: s.gid }, { parentId: s.gid }] }, select: { id: true } })
  const set = new Set(variants.map(v => v.id))
  const exported = (byGroup.get(s.gid) ?? []).filter(r => r.productId && set.has(r.productId)).length
  if (exported !== s.n) console.log(`  SHORT ${s.sku}: grid=${s.n} export=${exported} missing=${s.n - exported}`)
}

// ---- detail-page rowKey collisions (lane|channel|marketplace|sku|itemId) ----
console.log('\nRESULT detail-page rowKey collisions:')
for (const s of sized) {
  const seen = new Map<string, number>()
  for (const r of byGroup.get(s.gid) ?? []) {
    const k = `${r.lane}|${r.channel}|${r.marketplace}|${r.sku}|${r.itemId ?? ''}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  for (const [k, n] of seen) if (n > 1) console.log(`  COLLIDE group=${s.sku} key="${k}" x${n}`)
}
await prisma.$disconnect()
