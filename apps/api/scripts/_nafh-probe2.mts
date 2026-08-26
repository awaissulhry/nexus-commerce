import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
console.log('products:', await prisma.product.count())
console.log('channelListings:', await prisma.channelListing.count())
console.log('adProductAds total:', await prisma.adProductAd.count())
const ads = await prisma.adProductAd.findMany({ take: 3, select: { sku: true, asin: true, productId: true, creativeJson: true } })
console.log('sample ads:', JSON.stringify(ads).slice(0, 600))
await prisma.$disconnect()
