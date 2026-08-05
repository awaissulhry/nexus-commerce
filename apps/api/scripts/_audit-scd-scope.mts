/* eslint-disable no-console */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// ── replicate computeRows() productId sourcing (lightweight) ──
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true, product: { select: { sku: true } } },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true },
})

type R = { lane: 'LISTING' | 'SHARED'; sku: string; productId: string | null; channel: string; marketplace: string; itemId?: string }
const rows: R[] = [
  ...listings.map((l) => ({ lane: 'LISTING' as const, sku: l.product?.sku ?? '?', productId: l.productId, channel: l.channel, marketplace: l.marketplace })),
  ...memberships.map((m) => ({ lane: 'SHARED' as const, sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace, itemId: m.itemId })),
]

console.log('TOTAL ROWS', rows.length, 'LISTING', listings.length, 'SHARED', memberships.length)
console.log('SHARED rows with NULL productId (invisible to product view):', memberships.filter((m) => !m.productId).length)

const rowPids = [...new Set(rows.map((r) => r.productId).filter((p): p is string => Boolean(p)))]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true, sku: true } })
const masterOf = new Map(rowProducts.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]
console.log('masters:', masterIds.length)

// ── replicate resolveCanonicalMasters ──
const canonicalStem = (sku: string) => {
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
const groupIds = [...new Set(masterIds.map((m) => canonicalOf.get(m) ?? m))]
console.log('groups:', groupIds.length)

const skuById = new Map(masterSkus.map((m) => [m.id, m.sku]))
const membersByGroup = new Map<string, string[]>()
for (const mid of masterIds) {
  const gid = canonicalOf.get(mid)!
  if (gid !== mid) { const a = membersByGroup.get(gid) ?? []; a.push(mid); membersByGroup.set(gid, a) }
}

const groupIdOf = (pid: string) => canonicalOf.get(masterOf.get(pid) ?? pid) ?? pid
const byGroup = new Map<string, R[]>()
for (const r of rows) { if (!r.productId) continue; const g = groupIdOf(r.productId); const a = byGroup.get(g) ?? []; a.push(r); byGroup.set(g, a) }

// ── (c) export scope: filterExportRows(masterId) = rows whose productId ∈ {master, children(master)} ──
const kids = await prisma.product.findMany({ where: { parentId: { in: groupIds } }, select: { id: true, parentId: true } })
const kidsOf = new Map<string, string[]>()
for (const k of kids) { const a = kidsOf.get(k.parentId!) ?? []; a.push(k.id); kidsOf.set(k.parentId!, a) }

console.log('\n=== PER-GROUP: total rows in group vs rows the masterId EXPORT would emit ===')
let anyGap = false
for (const gid of groupIds) {
  const groupRows = byGroup.get(gid) ?? []
  const exportPids = new Set<string>([gid, ...(kidsOf.get(gid) ?? [])])
  const exported = groupRows.filter((r) => r.productId && exportPids.has(r.productId))
  const missing = groupRows.filter((r) => !(r.productId && exportPids.has(r.productId)))
  const mem = membersByGroup.get(gid) ?? []
  if (missing.length > 0 || mem.length > 0) {
    anyGap = anyGap || missing.length > 0
    console.log(
      `${(skuById.get(gid) ?? gid).padEnd(28)} members=${mem.length ? mem.map((m) => skuById.get(m)).join(',') : '-'}\n` +
      `    groupRows=${groupRows.length}  exported=${exported.length}  MISSING=${missing.length}`,
    )
    for (const m of missing.slice(0, 8)) console.log(`      MISS ${m.lane} ${m.sku} ${m.channel}/${m.marketplace}${m.itemId ? ' #' + m.itemId : ''}`)
    if (missing.length > 8) console.log(`      … +${missing.length - 8} more`)
  }
}
if (!anyGap) console.log('(no export gaps detected)')

// ── (a) bulk-action expansion reach + cap ──
console.log('\n=== BULK ACTION EXPANSION (grid path) ===')
for (const gid of groupIds) {
  const expandIds = [gid, ...(membersByGroup.get(gid) ?? [])]
  const pids = new Set<string>(expandIds)
  const ch = await prisma.product.findMany({ where: { parentId: { in: expandIds } }, select: { id: true } })
  for (const c of ch) pids.add(c.id)
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: [...pids] }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true, channel: true, marketplace: true } })
  const mems = await prisma.sharedListingMembership.findMany({ where: { productId: { in: [...pids] }, status: 'ACTIVE' }, select: { itemId: true } })
  const groupRows = byGroup.get(gid) ?? []
  const targets = cls.length + mems.length
  const dupTargets = cls.length - new Set(cls.map((c) => `${c.productId}|${c.channel}|${c.marketplace}`)).size
  if (targets !== groupRows.length || targets > 2000 || dupTargets > 0) {
    console.log(`${(skuById.get(gid) ?? gid).padEnd(28)} groupRows=${groupRows.length} actionTargets=${targets} (cls ${cls.length} + mem ${mems.length}) dupTuples=${dupTargets}`)
  }
}
const maxTargets = await (async () => {
  let mx = 0, who = ''
  for (const gid of groupIds) {
    const expandIds = [gid, ...(membersByGroup.get(gid) ?? [])]
    const pids = new Set<string>(expandIds)
    const ch = await prisma.product.findMany({ where: { parentId: { in: expandIds } }, select: { id: true } })
    for (const c of ch) pids.add(c.id)
    const n = await prisma.channelListing.count({ where: { productId: { in: [...pids] }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } } })
      + await prisma.sharedListingMembership.count({ where: { productId: { in: [...pids] }, status: 'ACTIVE' } })
    if (n > mx) { mx = n; who = skuById.get(gid) ?? gid }
  }
  return { mx, who }
})()
console.log('biggest single-group target count:', maxTargets, '(cap 3000)')
console.log('ALL groups selected at once => targets:',
  (await prisma.channelListing.count({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } } }))
  + (await prisma.sharedListingMembership.count({ where: { status: 'ACTIVE' } })), '(cap 3000)')

await prisma.$disconnect()
