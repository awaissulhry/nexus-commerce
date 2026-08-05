/** READ-ONLY: would publishEbayImagesViaInventory find a priced market for GALE? */
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true, productType: true } })
const kids = await prisma.product.findMany({ where: { parentId: p!.id, deletedAt: null }, select: { id: true, sku: true } })
console.log('parent productType:', p!.productType, ' children:', kids.length)
const childListings = await prisma.channelListing.findMany({
  where: { productId: { in: kids.map(k => k.id) }, channel: 'EBAY' },
  select: { region: true, marketplace: true, price: true, productId: true, externalListingId: true },
})
console.log('child eBay listings:', childListings.length)
const byMarket: Record<string, { total: number; priced: number }> = {}
for (const l of childListings) {
  const mp = l.region === 'GB' ? 'UK' : (l.region ?? l.marketplace ?? '?')
  byMarket[mp] ??= { total: 0, priced: 0 }
  byMarket[mp].total++
  if (l.price != null && Number(l.price) > 0) byMarket[mp].priced++
}
console.log('per market (total / priced>0):', JSON.stringify(byMarket))
const priced = Object.entries(byMarket).filter(([, v]) => v.priced > 0).map(([m]) => m)
console.log('=> allPricedMarkets:', JSON.stringify(priced))
console.log(priced.length === 0 ? '❌ WOULD RETURN EARLY: "No priced eBay markets" — publish does NOTHING' : '✅ would proceed to publish')
// curated rows present?
const cur = await prisma.listingImage.count({ where: { productId: p!.id, platform: 'EBAY' } })
console.log('curated EBAY ListingImage rows on parent:', cur)
await prisma.$disconnect()
