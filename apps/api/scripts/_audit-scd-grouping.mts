import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

function canonicalStem(sku: string): string {
  let s = sku.trim()
  s = s.replace(/^(IT|DE|FR|ES|UK|EU)-/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA)$/i, '')
  return s.toUpperCase()
}

// --- replicate computeRows' productId set (published listings + active memberships)
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' }, select: { productId: true },
})
const rowPids = [...new Set([...listings.map(l => l.productId), ...mems.map(m => m.productId).filter(Boolean) as string[]])]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true, sku: true } })
const masterOf = new Map(rowProducts.map(p => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id) ?? id))]
console.log('ROWPIDS', rowPids.length, 'MASTERS', masterIds.length)

const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const mastersWithChildren = new Set(withChildren.map(p => p.parentId!).filter(Boolean))
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true, name: true } })
const skuById = new Map(masterSkus.map(m => [m.id, m.sku]))

// === PROBE A: stem collisions among CHILD-OWNING masters (non-determinism) ===
const byStemChildOwning = new Map<string, string[]>()
for (const m of masterSkus) {
  if (!mastersWithChildren.has(m.id)) continue
  const s = canonicalStem(m.sku)
  byStemChildOwning.set(s, [...(byStemChildOwning.get(s) ?? []), `${m.sku}(${m.id.slice(0,8)})`])
}
console.log('\n=== A. stem collisions among CHILD-OWNING masters ===')
for (const [s, arr] of byStemChildOwning) if (arr.length > 1) console.log('COLLISION stem=', s, arr)

// === PROBE A2: does prisma return masterSkus in a stable order? ===
const o1 = (await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true } })).map(x => x.id).join(',')
const o2 = (await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true } })).map(x => x.id).join(',')
console.log('\n=== A2. findMany order stable across 2 calls:', o1 === o2)

// === PROBE B: empty / degenerate stems ===
console.log('\n=== B. degenerate stems ===')
for (const m of masterSkus) {
  const s = canonicalStem(m.sku)
  if (s === '' || s.length <= 3) console.log('SHORT STEM', JSON.stringify(m.sku), '->', JSON.stringify(s))
}

// === PROBE C: full resolution, replicating server ===
const childless = masterIds.filter(id => !mastersWithChildren.has(id))
const stemOfMaster = new Map<string,string>()
const canonicalByStem = new Map<string,string>()
for (const m of masterSkus) {
  const stem = canonicalStem(m.sku)
  stemOfMaster.set(m.id, stem)
  if (mastersWithChildren.has(m.id) && !canonicalByStem.has(stem)) canonicalByStem.set(stem, m.id)
}
const itemIdsByMaster = new Map<string,string[]>()
const canonicalMasterByItemId = new Map<string,string>()
if (childless.length) {
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: childless }, externalListingId: { not: null } },
    select: { productId: true, externalListingId: true, isPublished: true, listingStatus: true, channel: true },
  })
  const allItemIds = new Set<string>()
  for (const c of cls) {
    if (!c.externalListingId) continue
    itemIdsByMaster.set(c.productId, [...(itemIdsByMaster.get(c.productId) ?? []), c.externalListingId])
    allItemIds.add(c.externalListingId)
  }
  // report ENDED listings used for folding
  const ended = cls.filter(c => !c.isPublished || ['ENDED','REMOVED'].includes(c.listingStatus ?? ''))
  if (ended.length) console.log('\n=== C0. childless-master listings used for folding that are ENDED/unpublished:', ended.map(e => `${skuById.get(e.productId)}|${e.channel}|${e.listingStatus}|pub=${e.isPublished}|${e.externalListingId}`))
  if (allItemIds.size) {
    const ms = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItemIds] } }, select: { itemId: true, productId: true, status: true } })
    const inactive = ms.filter(m => m.status !== 'ACTIVE')
    if (inactive.length) console.log('=== C0b. non-ACTIVE memberships consulted:', inactive.length, inactive.slice(0,5))
    const memPids = [...new Set(ms.map(m => m.productId).filter(Boolean) as string[])]
    const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
    const masterOfProduct = new Map(memProducts.map(p => [p.id, p.parentId ?? p.id]))
    for (const m of ms) {
      if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue
      const canonical = masterOfProduct.get(m.productId)
      if (canonical && mastersWithChildren.has(canonical)) canonicalMasterByItemId.set(m.itemId, canonical)
    }
  }
}
const canonicalOf = new Map<string,string>()
const via = new Map<string,string>()
for (const mid of masterIds) {
  if (mastersWithChildren.has(mid)) { canonicalOf.set(mid, mid); via.set(mid,'self'); continue }
  let resolved = mid; let how = 'self-childless'
  for (const itemId of itemIdsByMaster.get(mid) ?? []) {
    const c = canonicalMasterByItemId.get(itemId)
    if (c && c !== mid) { resolved = c; how = 'pool:'+itemId; break }
  }
  if (resolved === mid) {
    const c = canonicalByStem.get(stemOfMaster.get(mid) ?? '\0')
    if (c && c !== mid) { resolved = c; how = 'stem:'+stemOfMaster.get(mid) }
  }
  canonicalOf.set(mid, resolved); via.set(mid, how)
}
const groups = new Map<string,string[]>()
for (const mid of masterIds) {
  const g = canonicalOf.get(mid)!
  groups.set(g, [...(groups.get(g) ?? []), mid])
}
console.log('\n=== C. groups:', groups.size, 'from masters', masterIds.length)
for (const [g, mem] of groups) {
  if (mem.length > 1) console.log(' GROUP', skuById.get(g), '<=', mem.filter(m=>m!==g).map(m => `${skuById.get(m)} [${via.get(m)}]`).join(', '))
}
console.log('\n LONE masters:', [...groups].filter(([,m])=>m.length===1).map(([g])=>skuById.get(g)).join(', '))

// === PROBE D: stem-folds where the two masters share NO pool ===
console.log('\n=== D. stem-folds (no pool evidence) ===')
for (const mid of masterIds) {
  if (via.get(mid)?.startsWith('stem:')) console.log('  ', skuById.get(mid), '-> ', skuById.get(canonicalOf.get(mid)!), 'stem', stemOfMaster.get(mid))
}

// === PROBE E: childless folded masters that own STOCK (pool double-count) ===
console.log('\n=== E. folded (childless) masters carrying their own StockLevel ===')
const folded = masterIds.filter(m => canonicalOf.get(m) !== m)
if (folded.length) {
  const lv = await prisma.stockLevel.findMany({ where: { productId: { in: folded }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true, location: { select: { code: true } } } })
  for (const l of lv) if (l.available !== 0) console.log('  ', skuById.get(l.productId), l.location?.code, 'available=', l.available, '-> ADDED to', skuById.get(canonicalOf.get(l.productId)!))
  if (!lv.some(l=>l.available!==0)) console.log('  none with nonzero stock (', lv.length, 'zero rows )')
} else console.log('  no folded masters')

// === PROBE F: transitivity — is any canonical itself folded? ===
console.log('\n=== F. canonical that is itself folded (orphaned group) ===')
for (const mid of masterIds) {
  const c = canonicalOf.get(mid)!
  if (c !== mid && canonicalOf.get(c) !== c) console.log('  CHAIN', skuById.get(mid), '->', skuById.get(c), '->', skuById.get(canonicalOf.get(c)!))
}
console.log('  (none printed = single-hop safe)')

await prisma.$disconnect()
