/** READ-ONLY: post-token verification — real outcomes + remaining parked rows. */
const { default: prisma } = await import('../src/db.js')
const att = await prisma.channelPublishAttempt.groupBy({
  by: ['outcome'],
  where: { channel: 'AMAZON', attemptedAt: { gte: new Date(Date.now() - 10 * 60e3) } },
  _count: { _all: true },
})
console.log('attempts last 10min:', JSON.stringify(att.map((a) => `${a.outcome}=${a._count._all}`)))
const parked = await prisma.outboundSyncQueue.count({
  where: { syncType: 'QUANTITY_UPDATE', targetChannel: 'AMAZON', syncStatus: { in: ['PENDING', 'FAILED', 'IN_PROGRESS'] }, isDead: false },
})
console.log(`Amazon qty rows still parked/pending: ${parked}`)
const recentFails = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', outcome: 'failed', attemptedAt: { gte: new Date(Date.now() - 10 * 60e3) } },
  take: 3,
  orderBy: { attemptedAt: 'desc' },
  select: { sku: true, errorMessage: true },
})
for (const f of recentFails) console.log(`  FAIL ${f.sku}: ${f.errorMessage?.slice(0, 140)}`)
const ok = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', targetChannel: 'AMAZON', syncStatus: 'SUCCESS', syncedAt: { gte: new Date(Date.now() - 10 * 60e3) } },
  take: 6,
  orderBy: { syncedAt: 'desc' },
  select: { payload: true, channelListing: { select: { product: { select: { sku: true } }, marketplace: true } } },
})
for (const o of ok) console.log(`  ✓ ${o.channelListing?.product?.sku}@${o.channelListing?.marketplace} qty=${(o.payload as { quantity?: number } | null)?.quantity}`)
await prisma.$disconnect()
process.exit(0)
