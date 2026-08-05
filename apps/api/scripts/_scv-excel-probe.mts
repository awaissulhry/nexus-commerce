/** READ-ONLY: build a Sync Control workbook from real rows, parse it back. */
const { default: prisma } = await import('../src/db.js')
const { buildSyncControlWorkbook, parseSyncControlWorkbook } = await import('../src/services/sync-control-excel.js')

// A handful of real published listings + memberships.
const cls = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
  select: { channel: true, marketplace: true, stockBuffer: true, product: { select: { sku: true, name: true } } },
  take: 5,
})
const listings = cls.map((c) => ({
  product: c.product?.name ?? '', sku: c.product?.sku ?? '?', channel: c.channel, market: c.marketplace, itemId: '',
  lane: 'LISTING', mode: 'Follow', pinnedQty: '' as const, buffer: c.stockBuffer ?? 0,
  pool: '' as const, intended: '' as const, live: '' as const, drift: '', locked: '',
}))
const routes = [{ location: 'IT-MAIN', type: 'WAREHOUSE', feeds: 'AMAZON:IT, EBAY' }]

const buf = await buildSyncControlWorkbook(listings, routes)
console.log('workbook bytes =', buf.length)
const parsed = await parseSyncControlWorkbook(buf)
console.log('parsed listings =', parsed.listings.length, '| routes =', parsed.routes.length)
console.log('sample edit:', JSON.stringify(parsed.listings[0]))
console.log('route edit:', JSON.stringify(parsed.routes[0]))
await prisma.$disconnect()
