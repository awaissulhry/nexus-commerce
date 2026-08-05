/** READ-ONLY: what ELSE wrote to eBay for GALE children after the 10:47 publish? */
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
const kids = await prisma.product.findMany({ where: { parentId: p!.id, deletedAt: null }, select: { id: true, sku: true } })
const ids = [p!.id, ...kids.map(k => k.id)]
const since = new Date('2026-07-26T04:00:00Z')

const q = await prisma.outboundSyncQueue.findMany({
  where: { productId: { in: ids }, createdAt: { gte: since } },
  orderBy: { createdAt: 'asc' },
  select: { createdAt: true, targetChannel: true, syncType: true, syncStatus: true, targetRegion: true, product: { select: { sku: true } } },
})
console.log(`OutboundSyncQueue rows since 04:00Z: ${q.length}`)
const byType: Record<string, number> = {}
for (const r of q) byType[`${r.targetChannel}:${r.syncType}:${r.syncStatus}`] = (byType[`${r.targetChannel}:${r.syncType}:${r.syncStatus}`] ?? 0) + 1
console.log('by channel:type:status →', JSON.stringify(byType, null, 1))
for (const r of q.filter(x => String(x.targetChannel) === 'EBAY').slice(0, 15)) {
  console.log(`  ${r.createdAt.toISOString()}  ${r.product?.sku}  ${r.syncType} ${r.syncStatus}`)
}

// audit table with actual attempt timestamps
const attempts = await prisma.channelPublishAttempt.findMany({
  where: { productId: { in: ids }, createdAt: { gte: since } },
  orderBy: { createdAt: 'asc' }, take: 30,
  select: { createdAt: true, channel: true, outcome: true, syncType: true },
}).catch(() => [])
console.log(`\nChannelPublishAttempt rows since 04:00Z: ${attempts.length}`)
const at: Record<string, number> = {}
for (const a of attempts as Array<{channel:string;outcome:string;syncType?:string}>) at[`${a.channel}:${a.syncType}:${a.outcome}`] = (at[`${a.channel}:${a.syncType}:${a.outcome}`] ?? 0) + 1
console.log('→', JSON.stringify(at))
await prisma.$disconnect()
