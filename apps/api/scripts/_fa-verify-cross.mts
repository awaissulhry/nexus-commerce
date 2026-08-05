const { default: prisma } = await import('../src/db.js')
// variants (products) with >1 marketplace on same channel, visible rows only
const rows = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, product: { select: { sku: true, fulfillmentMethod: true, parent: { select: { sku: true } } } } },
})
const byPC = new Map<string, Set<string>>()
const meta = new Map<string, any>()
for (const r of rows) {
  const k = `${r.productId}|${r.channel}`
  if (!byPC.has(k)) byPC.set(k, new Set())
  byPC.get(k)!.add(r.marketplace)
  meta.set(k, r)
}
const multi = [...byPC.entries()].filter(([,s]) => s.size > 1)
console.log('total listing rows', rows.length, 'product×channel keys', byPC.size, 'multi-market', multi.length)
// group by parent
const byParent = new Map<string, number>()
for (const [k, s] of multi) {
  const m = meta.get(k)
  const p = m.product?.parent?.sku ?? m.product?.sku
  byParent.set(`${p}|${m.channel}|${m.product?.fulfillmentMethod}`, (byParent.get(`${p}|${m.channel}|${m.product?.fulfillmentMethod}`) ?? 0) + 1)
}
console.log([...byParent.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20))
// concrete VENTRA sample
for (const [k, s] of multi) {
  const m = meta.get(k)
  if ((m.product?.sku ?? '').startsWith('VENTRA-JACKET')) console.log(m.product.sku, m.channel, m.product.fulfillmentMethod, [...s].join(','))
}
await prisma.$disconnect()
