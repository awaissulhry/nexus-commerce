/** VERIFY: run the eBay image read-back sweep once (what the cron will do).
 * Read-only vs eBay + full-replace of the ChannelLiveImage replica. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { readbackAllEbayLiveImages } = await import('../src/services/images/ebay-live-images.service.js')

const s = await readbackAllEbayLiveImages()
console.log('sweep summary:', JSON.stringify(s))

// spot-check: how many products now have eBay live-image rows?
const withRows = await prisma.channelLiveImage.groupBy({
  by: ['productId'],
  where: { channel: 'EBAY' },
  _count: { _all: true },
})
console.log('products with eBay ChannelLiveImage rows:', withRows.length)
console.log('total eBay live-image rows:', withRows.reduce((n, r) => n + r._count._all, 0))
await prisma.$disconnect()
