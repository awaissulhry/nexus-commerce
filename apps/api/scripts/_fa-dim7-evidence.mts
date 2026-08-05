const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, fulfillmentMethod: { not: 'FBA' }, product: { fulfillmentMethod: 'FBA' } },
  select: { id: true, channel: true, marketplace: true, fulfillmentMethod: true, quantity: true, followMasterQuantity: true, syncPaused: true, product: { select: { sku: true, id: true } } },
})
const byCh: Record<string, number> = {}
for (const l of listings) byCh[`${l.channel}:${l.marketplace}:lfm=${l.fulfillmentMethod}`] = (byCh[`${l.channel}:${l.marketplace}:lfm=${l.fulfillmentMethod}`] ?? 0) + 1
console.log('COUNT SC-shows-FBA / engine-FBM:', listings.length, byCh)

// Did the engine actually push these? look at OutboundSyncQueue history
const ids = listings.map((l) => l.id)
const q = await prisma.outboundSyncQueue.findMany({
  where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' },
  select: { channelListingId: true, syncStatus: true, targetChannel: true, createdAt: true, payload: true, syncedAt: true },
  orderBy: { createdAt: 'desc' },
  take: 12,
})
console.log('recent QUANTITY_UPDATE queue rows for those listings:', q.length)
for (const r of q) console.log(JSON.stringify({ ...r, payload: undefined, p: (r.payload as any)?.quantity }))

const total = await prisma.outboundSyncQueue.count({ where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE' } })
const succ = await prisma.outboundSyncQueue.count({ where: { channelListingId: { in: ids }, syncType: 'QUANTITY_UPDATE', syncStatus: { in: ['SUCCESS', 'COMPLETED', 'SENT'] } } })
console.log('total queue rows for these listings:', total, 'succeeded:', succ)
await prisma.$disconnect()
