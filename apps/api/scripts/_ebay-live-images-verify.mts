/** VERIFY: does the OAuth-fixed refreshEbayLiveImages actually pull live eBay
 * images now? Populates ChannelLiveImage (a read-replica) from live GetItem. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { refreshEbayLiveImages } = await import('../src/services/images/ebay-live-images.service.js')

for (const sku of ['VENTRA-JACKET', 'GALE-JACKET', 'IT-MOSS-JACKET']) {
  const p = await prisma.product.findFirst({ where: { sku, deletedAt: null }, select: { id: true } })
  if (!p) { console.log(`\n${sku}: NOT FOUND`); continue }
  const r = await refreshEbayLiveImages({ productId: p.id })
  console.log(`\n${sku}: ${JSON.stringify(r)}`)
  const rows = await prisma.channelLiveImage.findMany({
    where: { productId: p.id, channel: 'EBAY' },
    select: { externalSku: true, slot: true, url: true },
    orderBy: [{ externalSku: 'asc' }, { sortOrder: 'asc' }],
  })
  const byBucket: Record<string, number> = {}
  for (const row of rows) { const k = row.externalSku ?? '(gallery)'; byBucket[k] = (byBucket[k] || 0) + 1 }
  console.log('   ChannelLiveImage buckets:', JSON.stringify(byBucket))
  console.log('   sample urls:', JSON.stringify(rows.slice(0, 2).map((x) => x.url)))
}
await prisma.$disconnect()
