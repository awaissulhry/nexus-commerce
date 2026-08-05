/** FFT-I2 — read-only forensics: the GALE eBay multi-listing cluster state.
 *  Operator: saved OK, reloaded, sees ONE parent group instead of FOUR. */
const prisma = (await import('../src/db.js')).default

// 1. Memberships by (itemId, parentSku)
const mems = await prisma.sharedListingMembership.findMany({
  where: { OR: [{ parentSku: { contains: 'GALE' } }, { sku: { contains: 'GALE' } }] },
  select: { itemId: true, parentSku: true, sku: true, status: true, marketplace: true, updatedAt: true },
})
const byListing = new Map<string, { parentSku: string; status: Map<string, number>; count: number; lastUpd: string }>()
for (const m of mems) {
  const k = m.itemId
  const e = byListing.get(k) ?? { parentSku: m.parentSku ?? '?', status: new Map(), count: 0, lastUpd: '' }
  e.count++
  e.status.set(m.status, (e.status.get(m.status) ?? 0) + 1)
  const u = m.updatedAt.toISOString()
  if (u > e.lastUpd) e.lastUpd = u
  byListing.set(k, e)
}
console.log('── memberships by listing ──')
for (const [itemId, e] of byListing) {
  console.log(`${itemId} parentSku=${e.parentSku} n=${e.count} status={${[...e.status.entries()].map(([s, n]) => `${s}:${n}`).join(',')}} lastUpd=${e.lastUpd.slice(0, 16)}`)
}

// 2. GALE parents/shells (incl. soft-deleted!)
const parents = await prisma.product.findMany({
  where: { sku: { contains: 'GALE' }, OR: [{ isParent: true }, { productType: 'EBAY_LISTING_SHELL' }, { parentId: null }] },
  select: { id: true, sku: true, isParent: true, productType: true, parentId: true, deletedAt: true, categoryAttributes: true, updatedAt: true },
})
console.log('── GALE parent-ish products ──')
for (const p of parents) {
  const ca = (p.categoryAttributes ?? {}) as Record<string, unknown>
  const excluded = JSON.stringify(ca.ebayFileExcluded ?? null)
  const clusterParent = JSON.stringify(ca.ebayClusterParent ?? null)
  console.log(`${p.sku} type=${p.productType} isParent=${p.isParent} parentId=${p.parentId ?? '-'} deletedAt=${p.deletedAt ? p.deletedAt.toISOString().slice(0, 16) : 'null'} excluded=${excluded} clusterParent=${clusterParent} upd=${p.updatedAt.toISOString().slice(0, 16)}`)
}

// 3. Their eBay CLs
const ids = parents.map((p) => p.id)
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: ids }, channel: 'EBAY' },
  select: { productId: true, region: true, externalListingId: true, listingStatus: true, updatedAt: true, flatFileSnapshot: true },
})
const skuById = new Map(parents.map((p) => [p.id, p.sku]))
console.log('── parent eBay CLs ──')
for (const c of cls) {
  const snap = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  const planned = Array.isArray(snap._plannedChildren) ? (snap._plannedChildren as unknown[]).length : 0
  console.log(`${skuById.get(c.productId!)} ${c.region} itemId=${c.externalListingId ?? '-'} status=${c.listingStatus} snapKeys=${Object.keys(snap).length} planned=${planned} upd=${c.updatedAt.toISOString().slice(0, 16)}`)
}
await prisma.$disconnect()
process.exit(0)
