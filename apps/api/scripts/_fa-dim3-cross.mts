const { default: prisma } = await import('../src/db.js')
const out = (k: string, v: unknown) => console.log('###', k, JSON.stringify(v, null, 1))

for (const parentSku of ['VENTRA-JACKET', 'REGAL-JACKET', 'IT-MOSS-JACKET', 'AIRMESH-JACKET']) {
  const p = await prisma.product.findFirst({ where: { sku: parentSku }, select: { id: true } })
  if (!p) continue
  const kids = await prisma.product.findMany({ where: { parentId: p.id }, select: { id: true, sku: true, fulfillmentMethod: true } })
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: kids.map((k) => k.id) }, channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: { productId: true, marketplace: true, quantity: true, followMasterQuantity: true, fulfillmentMethod: true, product: { select: { sku: true, fulfillmentMethod: true } } },
  })
  const byPid = new Map<string, string[]>()
  for (const c of cls) { const a = byPid.get(c.productId) ?? []; a.push(c.marketplace); byPid.set(c.productId, a) }
  const multi = [...byPid.entries()].filter(([, m]) => new Set(m).size > 1)
  // pick two DIFFERENT variants that each live on >=2 markets, non-FBA
  const pairs = multi.slice(0, 2).map(([pid, mk]) => ({ sku: cls.find((c) => c.productId === pid)?.product?.sku, markets: [...new Set(mk)], fba: cls.find((c) => c.productId === pid)?.product?.fulfillmentMethod }))
  out(parentSku, { amazonListings: cls.length, variantsOnMultipleMarkets: multi.length, examplePair: pairs, rowsIfTwoSelected: pairs.length === 2 ? 'select A@' + pairs[0].markets[0] + ' + B@' + pairs[1].markets[1] + ' -> server writes ' + (2 * 2) + ' rows' : 'n/a' })
}
await prisma.$disconnect()
