/** READ-ONLY: do the duplicate copies of a group SHARE child SKUs?
 *  Checks 3 places a "child SKU" can live per master: Product children (parentId),
 *  SharedListingMembership (itemId×sku pool), and ChannelListing.sku. */
const { default: prisma } = await import('../src/db.js')

async function childSkusOf(masterSku: string) {
  const m = await prisma.product.findFirst({ where: { sku: masterSku }, select: { id: true } })
  if (!m) return { productChildren: new Set<string>(), memberships: new Set<string>(), listingSkus: new Set<string>(), listingItemIds: [] as string[] }
  // (a) Product children
  const kids = await prisma.product.findMany({ where: { parentId: m.id }, select: { sku: true } })
  // (b) ChannelListings on the master itself + its children
  const ids = [m.id, ...(await prisma.product.findMany({ where: { parentId: m.id }, select: { id: true } })).map(x=>x.id)]
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: ids } }, select: { externalListingId: true, channel: true } })
  // (c) SharedListingMemberships for those products (the pool) — AND by the master's own listing itemIds
  const itemIds = [...new Set(cls.map(c=>c.externalListingId).filter(Boolean) as string[])]
  const memsByProduct = await prisma.sharedListingMembership.findMany({ where: { productId: { in: ids } }, select: { sku: true } })
  const memsByItem = itemIds.length ? await prisma.sharedListingMembership.findMany({ where: { itemId: { in: itemIds } }, select: { sku: true } }) : []
  return {
    productChildren: new Set(kids.map(k=>k.sku)),
    memberships: new Set([...memsByProduct.map(x=>x.sku), ...memsByItem.map(x=>x.sku)]),
    listingSkus: new Set<string>(),
    listingItemIds: itemIds,
  }
}

for (const cluster of [
  ['GALE', ['GALE-JACKET','GALE-JACKET-ALT1','GALE-JACKET-ALT2','GALE-JACKET-ALT3','IT-GALE-JACKET','GALE-JACKET-FBM']],
  ['AIRMESH', ['AIRMESH-JACKET','AIR-MESH-JACKET-MEN','AIRMESH-JACKET-ALT1']],
] as const) {
  console.log(`\n======== ${cluster[0]} ========`)
  const canon = await childSkusOf(cluster[1][0])
  console.log(`CANONICAL ${cluster[1][0]}: productChildren=${canon.productChildren.size} memberships=${canon.memberships.size} listingSKUs=${canon.listingSkus.size} itemIds=${canon.listingItemIds.length}`)
  const canonAll = new Set([...canon.productChildren, ...canon.memberships, ...canon.listingSkus])
  for (const sku of cluster[1].slice(1)) {
    const c = await childSkusOf(sku)
    const cAll = new Set([...c.productChildren, ...c.memberships, ...c.listingSkus])
    const shared = [...cAll].filter(x=>canonAll.has(x)).length
    console.log(`  ${sku}: prodKids=${c.productChildren.size} mem=${c.memberships.size} listingSKUs=${c.listingSkus.size} itemIds=${c.listingItemIds.length}  → shares ${shared}/${cAll.size} child SKUs w/ canonical`)
    if (cAll.size>0 && cAll.size<=6) console.log(`       its SKUs: ${[...cAll].join(', ')}`)
  }
}
await prisma.$disconnect()
