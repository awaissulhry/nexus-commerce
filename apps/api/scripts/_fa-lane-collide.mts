const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] }, channel: 'EBAY' },
  select: { productId: true, marketplace: true, product: { select: { sku: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, marketplace: true, itemId: true, productId: true },
})
const lkey = new Map<string, {pid:string}>()
for (const l of listings) lkey.set(`${l.product?.sku ?? '?'}|EBAY|${l.marketplace}`, { pid: l.productId })
let collide = 0
const samples: any[] = []
const bySkuMkt = new Map<string, number>()
for (const m of mems) {
  const k = `${m.sku}|EBAY|${m.marketplace}`
  bySkuMkt.set(k, (bySkuMkt.get(k) ?? 0) + 1)
  const hit = lkey.get(k)
  if (hit) { collide++; if (samples.length < 8) samples.push({ sku: m.sku, mkt: m.marketplace, itemId: m.itemId, memPid: m.productId, listingPid: hit.pid, samePid: hit.pid === m.productId }) }
}
console.log('ebay listing rows', listings.length, 'membership rows', mems.length)
console.log('memberships whose (sku,market) also exists as a LISTING row:', collide)
console.log('distinct colliding keys:', new Set(mems.filter(m=>lkey.has(`${m.sku}|EBAY|${m.marketplace}`)).map(m=>`${m.sku}|${m.marketplace}`)).size)
console.log(JSON.stringify(samples, null, 1))
// how many memberships share the same (sku,market) across multiple itemIds
const multi = [...bySkuMkt.entries()].filter(([,n]) => n > 1)
console.log('sku|market keys with >1 membership itemId:', multi.length)
await prisma.$disconnect()
