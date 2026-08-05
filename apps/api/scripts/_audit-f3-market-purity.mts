// READ-ONLY audit for F3 (Trading shared-listing push market purity).
// No writes, no eBay calls.
const { default: prisma } = await import('../src/db.js')

const out: Record<string, unknown> = {}

// 1. Shared-listing memberships by marketplace (who uses the Trading lane at all)
const byMkt = await prisma.sharedListingMembership.groupBy({
  by: ['marketplace'],
  _count: { _all: true },
})
out.membershipsByMarketplace = byMkt.map((m) => ({ marketplace: m.marketplace, count: m._count._all }))

// 2. Distinct itemIds + parentSkus per marketplace
const rows = await prisma.sharedListingMembership.findMany({
  select: { marketplace: true, itemId: true, parentSku: true, variationSpecifics: true },
})
const perMkt = new Map<string, { items: Set<string>; parents: Set<string>; axisNames: Map<string, number> }>()
for (const r of rows) {
  const k = r.marketplace
  if (!perMkt.has(k)) perMkt.set(k, { items: new Set(), parents: new Set(), axisNames: new Map() })
  const e = perMkt.get(k)!
  if (r.itemId) e.items.add(r.itemId)
  if (r.parentSku) e.parents.add(r.parentSku)
  const vs = (r.variationSpecifics ?? {}) as Record<string, unknown>
  for (const n of Object.keys(vs)) e.axisNames.set(n, (e.axisNames.get(n) ?? 0) + 1)
}
out.perMarketMembershipShape = [...perMkt.entries()].map(([mkt, e]) => ({
  marketplace: mkt,
  listings: e.items.size,
  parents: e.parents.size,
  axisNamesTransmitted: [...e.axisNames.entries()].sort((a, b) => b[1] - a[1]),
}))

// 3. Which markets have shared_sku_listing = true parents (routes to the Trading lane)
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { marketplace: true, platformAttributes: true, product: { select: { sku: true } } },
})
const sharedByMkt = new Map<string, string[]>()
const aspectKeysByMkt = new Map<string, Map<string, number>>()
for (const cl of cls) {
  const pa = (cl.platformAttributes ?? {}) as Record<string, unknown>
  const mkt = cl.marketplace ?? '?'
  if (pa.sharedSkuListing === true) {
    if (!sharedByMkt.has(mkt)) sharedByMkt.set(mkt, [])
    sharedByMkt.get(mkt)!.push(cl.product?.sku ?? '?')
  }
  const is = (pa.itemSpecifics ?? {}) as Record<string, unknown>
  if (!aspectKeysByMkt.has(mkt)) aspectKeysByMkt.set(mkt, new Map())
  const m = aspectKeysByMkt.get(mkt)!
  for (const k of Object.keys(is)) m.set(k, (m.get(k) ?? 0) + 1)
}
out.sharedSkuListingParentsByMarket = [...sharedByMkt.entries()].map(([m, skus]) => ({
  marketplace: m, count: skus.length, sample: skus.slice(0, 10),
}))
out.itemSpecificNamesByMarket = [...aspectKeysByMkt.entries()].map(([m, names]) => ({
  marketplace: m,
  top: [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25),
}))

// 4. Non-IT products' variationTheme (what a DE product would declare)
const nonItListings = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', NOT: { marketplace: 'IT' } },
  select: {
    marketplace: true, listingStatus: true, externalListingId: true,
    product: { select: { sku: true, variationTheme: true, parentId: true } },
  },
})
out.nonItListings = nonItListings.map((l) => ({
  marketplace: l.marketplace,
  status: l.listingStatus,
  itemId: l.externalListingId,
  sku: l.product?.sku,
  theme: l.product?.variationTheme,
  isChild: !!l.product?.parentId,
}))

console.log(JSON.stringify(out, null, 2))
await prisma.$disconnect()
