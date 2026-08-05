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

// ===== A. ACTIVE memberships with NULL productId -> silently dropped from Products view =====
const nullPid = memsActive.filter(m => !m.productId)
console.log('=== A. ACTIVE shared memberships with productId=NULL (dropped by products view) ===')
console.log('count:', nullPid.length, 'of', memsActive.length)
for (const m of nullPid.slice(0, 15)) console.log('   ', m.itemId, m.marketplace, m.sku)

const rowPids = [...new Set([...listings.map(l => l.productId), ...memsActive.map(m => m.productId).filter(Boolean) as string[]])]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true, sku: true } })
const masterOf = new Map(rowProducts.map(p => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id) ?? id))]
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const mastersWithChildren = new Set(withChildren.map(p => p.parentId!).filter(Boolean))
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })
const skuById = new Map(masterSkus.map(m => [m.id, m.sku]))
const childless = masterIds.filter(id => !mastersWithChildren.has(id))

// ===== B. itemId -> multiple child-owning canonicals (order-dependent winner) =====
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: childless }, externalListingId: { not: null } },
  select: { productId: true, externalListingId: true, channel: true, isPublished: true, listingStatus: true },
})
const itemIdsByMaster = new Map<string, string[]>()
const allItemIds = new Set<string>()
for (const c of cls) {
  if (!c.externalListingId) continue
  itemIdsByMaster.set(c.productId, [...(itemIdsByMaster.get(c.productId) ?? []), c.externalListingId])
  allItemIds.add(c.externalListingId)
}
console.log('\n=== B0. childless-master listings feeding the fold (channel/status) ===')
for (const c of cls) console.log('   ', (skuById.get(c.productId) ?? c.productId).padEnd(30), c.channel, c.listingStatus, 'pub=' + c.isPublished, c.externalListingId)

const allMems = await prisma.sharedListingMembership.findMany({
  where: { itemId: { in: [...allItemIds] } },
  select: { itemId: true, productId: true, status: true, sku: true },
})
const memPids = [...new Set(allMems.map(m => m.productId).filter(Boolean) as string[])]
const memProducts = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true, sku: true } })
const masterOfProduct = new Map(memProducts.map(p => [p.id, p.parentId ?? p.id]))

const canonSetByItem = new Map<string, Set<string>>()
for (const m of allMems) {
  if (!m.productId) continue
  const c = masterOfProduct.get(m.productId)
  if (c && mastersWithChildren.has(c)) {
    const s = canonSetByItem.get(m.itemId) ?? new Set<string>(); s.add(c); canonSetByItem.set(m.itemId, s)
  }
}
console.log('\n=== B. itemId mapping to >1 child-owning canonical (winner = unordered findMany) ===')
let amb = 0
for (const [it, s] of canonSetByItem) if (s.size > 1) { amb++; console.log('   AMBIGUOUS', it, [...s].map(i => skuById.get(i) ?? i)) }
if (!amb) console.log('   (none today)')

console.log('\n=== C. childless master whose itemIds resolve to >1 DIFFERENT canonical (first-itemId-wins) ===')
let ambM = 0
for (const mid of childless) {
  const canons = new Set<string>()
  for (const it of itemIdsByMaster.get(mid) ?? []) for (const c of (canonSetByItem.get(it) ?? [])) canons.add(c)
  if (canons.size > 1) { ambM++; console.log('   ', skuById.get(mid), 'items=', itemIdsByMaster.get(mid), '->', [...canons].map(c => skuById.get(c))) }
}
if (!ambM) console.log('   (none today)')

// ===== D. stem collisions across ALL products in DB (latent flap surface) =====
const allProducts = await prisma.product.findMany({ select: { id: true, sku: true, parentId: true } })
const parentSet = new Set(allProducts.map(p => p.parentId).filter(Boolean) as string[])
const byStem = new Map<string, { sku: string; owns: boolean }[]>()
for (const p of allProducts) {
  if (p.parentId) continue // masters only
  const s = canonicalStem(p.sku)
  byStem.set(s, [...(byStem.get(s) ?? []), { sku: p.sku, owns: parentSet.has(p.id) }])
}
console.log('\n=== D. ALL top-level products sharing a stem (would merge if the loser were childless) ===')
for (const [s, arr] of byStem) {
  if (arr.length > 1) console.log('   stem', s, '=>', arr.map(a => `${a.sku}${a.owns ? '[owns-children]' : '[childless]'}`).join(' , '))
}
console.log('   total top-level products:', allProducts.filter(p => !p.parentId).length)

// ===== E. degenerate stems across ALL products =====
console.log('\n=== E. degenerate stems (empty / <=3 chars) across ALL top-level products ===')
for (const p of allProducts) {
  if (p.parentId) continue
  const s = canonicalStem(p.sku)
  if (s.length <= 3) console.log('   ', JSON.stringify(p.sku), '->', JSON.stringify(s), parentSet.has(p.id) ? '[owns-children]' : '[childless]')
}

await prisma.$disconnect()
