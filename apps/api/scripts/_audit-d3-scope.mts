/* READ-ONLY audit probe — SCD dimension 3 (action & export scope). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { id: true, productId: true, channel: true, marketplace: true, externalListingId: true, product: { select: { sku: true } } },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { id: true, sku: true, itemId: true, marketplace: true, productId: true },
})

type R = { lane: 'LISTING' | 'SHARED'; sku: string; productId: string | null; channel: string; marketplace: string; itemId?: string }
const rows: R[] = []
for (const l of listings) rows.push({ lane: 'LISTING', sku: l.product?.sku ?? '?', productId: l.productId, channel: l.channel, marketplace: l.marketplace })
for (const m of memberships) rows.push({ lane: 'SHARED', sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace, itemId: m.itemId })

console.log('ROWS total', rows.length, 'listings', listings.length, 'memberships', memberships.length)
const nullPid = rows.filter((r) => !r.productId)
console.log('ROWS with NULL productId (dropped by products view):', nullPid.length,
  JSON.stringify(nullPid.slice(0, 12).map((r) => `${r.lane}|${r.sku}|${r.marketplace}|${r.itemId ?? ''}`)))

const rowPids = [...new Set(rows.map((r) => r.productId).filter((p): p is string => !!p))]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]

const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')

const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })
const mastersWithChildren = new Set(withChildren.map((p) => p.parentId!).filter(Boolean))
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
    const memPids = [...new Set(mems.map((m) => m.productId).filter((x): x is string => !!x))]
    const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
    const mop = new Map(memProducts.map((p) => [p.id, p.parentId ?? p.id]))
    for (const m of mems) {
      if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue
      const canon = mop.get(m.productId)
      if (canon && mastersWithChildren.has(canon)) canonicalMasterByItemId.set(m.itemId, canon)
    }
  }
}
const canonicalOf = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
const groupIdOf = (pid: string) => { const mid = masterOf.get(pid) ?? pid; return canonicalOf.get(mid) ?? mid }
const groupIds = [...new Set(masterIds.map((m) => canonicalOf.get(m) ?? m))]
console.log('masters', masterIds.length, '-> groups', groupIds.length)

const membersByGroup = new Map<string, string[]>()
for (const mid of masterIds) { const g = canonicalOf.get(mid) ?? mid; if (g !== mid) { const a = membersByGroup.get(g) ?? []; a.push(mid); membersByGroup.set(g, a) } }

const skuById = new Map(masterSkus.map((m) => [m.id, m.sku]))
const byGroup = new Map<string, R[]>()
for (const r of rows) { if (!r.productId) continue; const g = groupIdOf(r.productId); const a = byGroup.get(g) ?? []; a.push(r); byGroup.set(g, a) }

console.log('\n=== (a) ACTION EXPANSION COVERAGE PER GROUP ===')
for (const g of groupIds) {
  const grpRows = byGroup.get(g) ?? []
  const send = [g, ...(membersByGroup.get(g) ?? [])]
  const variants = await prisma.product.findMany({ where: { OR: [{ id: { in: send } }, { parentId: { in: send } }] }, select: { id: true } })
  const pids = new Set(variants.map((v) => v.id))
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: [...pids] }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true, channel: true, marketplace: true } })
  const mems = await prisma.sharedListingMembership.findMany({ where: { productId: { in: [...pids] }, status: 'ACTIVE' }, select: { itemId: true, marketplace: true, sku: true } })
  const targetCount = cls.length + mems.length
  const uncovered = grpRows.filter((r) => r.productId && !pids.has(r.productId))
  const seen = new Map<string, number>()
  for (const c of cls) { const k = `${c.productId}|${c.channel}|${c.marketplace}`; seen.set(k, (seen.get(k) ?? 0) + 1) }
  const dupTargets = [...seen.entries()].filter(([, n]) => n > 1)
  console.log(`${(skuById.get(g) ?? g).padEnd(30)} rows=${String(grpRows.length).padStart(4)} members=${(membersByGroup.get(g) ?? []).length} pids=${pids.size} targets=${targetCount}(cl=${cls.length},mem=${mems.length}) uncovered=${uncovered.length} dupListingTargets=${dupTargets.length}`)
  if (uncovered.length) console.log('    UNCOVERED:', uncovered.slice(0, 8).map((r) => `${r.lane}|${r.sku}|${r.channel}:${r.marketplace}|${r.itemId ?? ''}`))
}

console.log('\n=== (a2) FOLLOW/PIN/BUFFER OVER-REACH ===')
for (const g of groupIds) {
  const send = [g, ...(membersByGroup.get(g) ?? [])]
  const variants = await prisma.product.findMany({ where: { OR: [{ id: { in: send } }, { parentId: { in: send } }] }, select: { id: true } })
  const pids = variants.map((v) => v.id)
  const visible = await prisma.channelListing.findMany({ where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true, channel: true, marketplace: true } })
  const channels = [...new Set(visible.map((v) => v.channel))]
  let extra = 0
  const samples: string[] = []
  for (const ch of channels) {
    const markets = [...new Set(visible.filter((v) => v.channel === ch).map((v) => v.marketplace))]
    const touched = await prisma.channelListing.findMany({ where: { productId: { in: pids }, channel: ch, marketplace: { in: markets }, listingStatus: { not: 'ENDED' } }, select: { id: true, productId: true, channel: true, marketplace: true, isPublished: true, listingStatus: true, product: { select: { sku: true } } } })
    for (const t of touched) {
      const isVisible = visible.some((v) => v.productId === t.productId && v.channel === t.channel && v.marketplace === t.marketplace)
      if (!isVisible) { extra++; if (samples.length < 5) samples.push(`${t.product?.sku}@${t.channel}:${t.marketplace} pub=${t.isPublished} st=${t.listingStatus}`) }
    }
  }
  if (extra > 0) console.log(`${(skuById.get(g) ?? g).padEnd(30)} INVISIBLE listings also written: ${extra}`, samples)
}

console.log('\n=== (c) EXPORT masterId SCOPE vs GROUP ROWS ===')
for (const g of groupIds) {
  const grpRows = byGroup.get(g) ?? []
  const exportPids = new Set(rowPids.filter((pid) => groupIdOf(pid) === g))
  const exported = rows.filter((r) => r.productId && exportPids.has(r.productId))
  const oldPids = new Set((await prisma.product.findMany({ where: { OR: [{ id: g }, { parentId: g }] }, select: { id: true } })).map((p) => p.id))
  const oldExported = rows.filter((r) => r.productId && oldPids.has(r.productId)).length
  if (exported.length !== grpRows.length || oldExported !== grpRows.length) {
    console.log(`${(skuById.get(g) ?? g).padEnd(30)} groupRows=${grpRows.length} exportedNow=${exported.length} exportedOldWay=${oldExported}`)
  }
}

console.log('\n=== (b) DETAIL PAGE rowKey COLLISIONS ===')
for (const g of groupIds) {
  const grpRows = byGroup.get(g) ?? []
  const keys = new Map<string, number>()
  for (const r of grpRows) { const k = `${r.lane}|${r.channel}|${r.marketplace}|${r.sku}|${r.itemId ?? ''}`; keys.set(k, (keys.get(k) ?? 0) + 1) }
  const dups = [...keys.entries()].filter(([, n]) => n > 1)
  if (dups.length) console.log(`${(skuById.get(g) ?? g).padEnd(30)} collisions=${dups.length}`, JSON.stringify(dups.slice(0, 6)))
}

console.log('\n=== EXCEL rowKeyOf COLLISIONS ===')
const ek = new Map<string, number>()
for (const r of rows) { const k = `${r.lane}|${r.sku}|${r.channel}|${r.marketplace}|${r.itemId ?? ''}`; ek.set(k, (ek.get(k) ?? 0) + 1) }
console.log('colliding keys:', JSON.stringify([...ek.entries()].filter(([, n]) => n > 1).slice(0, 20)))

await prisma.$disconnect()
