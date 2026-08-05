const { default: prisma } = await import('../src/db.js')

// 1. CategorySchema rows for EBAY
const schemas = await prisma.categorySchema.findMany({
  where: { channel: 'EBAY' },
  select: { marketplace: true, productType: true, schemaVersion: true, fetchedAt: true, isActive: true },
})
console.log('=== CategorySchema channel=EBAY ===')
for (const s of schemas) console.log(s.marketplace, s.productType, s.schemaVersion, s.isActive, s.fetchedAt?.toISOString())

// 2. ChannelListing EBAY DE rows and their aspect keys
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { id: true, region: true, externalListingId: true, listingStatus: true, flatFileSnapshot: true, product: { select: { sku: true, productType: true, deletedAt: true } } },
})
const byRegion = new Map<string, Map<string, number>>()
const deRows: any[] = []
for (const c of cls) {
  const snap = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  const keys = Object.keys(snap).filter((k) => k.startsWith('aspect_'))
  const r = c.region ?? '??'
  if (!byRegion.has(r)) byRegion.set(r, new Map())
  const m = byRegion.get(r)!
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
  if (r === 'DE') deRows.push({ sku: c.product?.sku, deleted: !!c.product?.deletedAt, status: (c as any).listingStatus, ext: c.externalListingId, cat: snap.ebay_category ?? snap.category_id ?? snap.categoryId ?? snap.ebay_category_id, theme: snap.variation_theme, keys })
}
console.log('\n=== aspect_* keys by ChannelListing.region ===')
for (const [r, m] of byRegion) {
  console.log(`--- ${r} ---`)
  console.log([...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', '))
}
console.log('\n=== DE rows detail ===')
for (const d of deRows) console.log(JSON.stringify(d))

// 3. SharedListingMembership marketplaces
const mem = await prisma.sharedListingMembership.groupBy({ by: ['marketplace'], _count: { _all: true } })
console.log('\n=== SharedListingMembership by marketplace ===', JSON.stringify(mem))

await prisma.$disconnect()
