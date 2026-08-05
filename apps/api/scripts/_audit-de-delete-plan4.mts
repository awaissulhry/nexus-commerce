/** READ-ONLY: does the eBay DE market survive in the UI after the ChannelListing rows go? */
const { default: prisma } = await import('../src/db.js')
const m = await prisma.marketplace.findMany({ where: { channel: 'EBAY' }, select: { code: true, isActive: true, language: true, name: true } })
console.log('Marketplace rows (channel=EBAY):', JSON.stringify(m))
await prisma.$disconnect()
