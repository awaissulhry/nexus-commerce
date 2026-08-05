/** READ-ONLY: how many products are shared across MULTIPLE markets today?
 * Determines the scope of a "separate product per market" model. */
const { default: prisma } = await import('../src/db.js')

const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { productId: true, marketplace: true, channelMarket: true, externalListingId: true, product: { select: { sku: true, parentId: true, deletedAt: true } } },
})
const byProduct = new Map<string, Set<string>>()
const live = new Map<string, Set<string>>()
for (const c of cls) {
  if (c.product?.deletedAt) continue
  const mkt = (c.marketplace || c.channelMarket || '?').toUpperCase()
  const s = byProduct.get(c.productId) ?? new Set(); s.add(mkt); byProduct.set(c.productId, s)
  if (c.externalListingId) { const l = live.get(c.productId) ?? new Set(); l.add(mkt); live.set(c.productId, l) }
}
const multi = [...byProduct.entries()].filter(([, s]) => s.size > 1)
const multiLive = [...live.entries()].filter(([, s]) => s.size > 1)
console.log('eBay ChannelListing rows:', cls.length)
console.log('distinct products with an eBay listing row:', byProduct.size)
console.log('products with rows in >1 MARKET:', multi.length)
console.log('products with LIVE listings in >1 market:', multiLive.length)

const mktCount: Record<string, number> = {}
for (const [, s] of byProduct) for (const m of s) mktCount[m] = (mktCount[m] || 0) + 1
console.log('products per market:', JSON.stringify(mktCount))

// which markets, and are the non-IT ones live or draft?
const perMarketLive: Record<string, { live: number; draft: number }> = {}
for (const c of cls) {
  if (c.product?.deletedAt) continue
  const mkt = (c.marketplace || c.channelMarket || '?').toUpperCase()
  perMarketLive[mkt] ??= { live: 0, draft: 0 }
  if (c.externalListingId) perMarketLive[mkt].live++; else perMarketLive[mkt].draft++
}
console.log('per-market listing rows (live = has ItemID):', JSON.stringify(perMarketLive))

// sample multi-market products
console.log('\nsample multi-market products:')
for (const [pid, s] of multi.slice(0, 12)) {
  const sku = cls.find((c) => c.productId === pid)?.product?.sku
  console.log(`   ${sku} → markets ${JSON.stringify([...s])}`)
}
await prisma.$disconnect()
