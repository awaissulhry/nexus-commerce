/** READ-ONLY: what volume would LISTINGS_ITEM_MFN_QUANTITY_CHANGE add, and what UI does it touch? */
const { default: prisma } = await import('../src/db.js')
const day = 24 * 3600e3

// 1. Echo volume: every Amazon qty push we make would bounce back as a notification.
const since7 = new Date(Date.now() - 7 * day)
const pushes = await prisma.outboundSyncQueue.count({
  where: { createdAt: { gte: since7 }, targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE' },
})
const delivered = await prisma.outboundSyncQueue.count({
  where: { createdAt: { gte: since7 }, targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', syncStatus: 'SUCCESS' },
})
console.log(`Amazon QUANTITY_UPDATE rows last 7d: ${pushes} (SUCCESS ${delivered}) → ~${Math.round(pushes / 7)}/day enqueued, ~${Math.round(delivered / 7)}/day that would echo`)

// Amazon FBM listings in scope = the notification's natural fan-out per push
const fbmListings = await prisma.channelListing.count({
  where: { channel: 'AMAZON', isPublished: true, offerClosedAt: null, syncPaused: false,
    OR: [{ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: null, product: { fulfillmentMethod: { not: 'FBA' } } }] },
})
console.log(`published open FBM Amazon listings (notification surface): ${fbmListings}`)

// 2. WebhookEvent — every SQS/EventBridge message is persisted and rendered in /sync-logs/webhooks
const weTotal = await prisma.webhookEvent.count()
const we7 = await prisma.webhookEvent.count({ where: { createdAt: { gte: since7 } } })
const weByType = await prisma.webhookEvent.groupBy({
  by: ['eventType'], where: { createdAt: { gte: since7 } }, _count: { _all: true },
})
console.log(`\nWebhookEvent rows total: ${weTotal} · last 7d: ${we7} (~${Math.round(we7 / 7)}/day)`)
console.log('  by type last 7d:', JSON.stringify(weByType.map((w) => `${w.eventType}=${w._count._all}`)))

// 3. Is WebhookEvent covered by the retention job?
console.log('\n(check observability-retention.job.ts for WebhookEvent coverage)')

// 4. How often does a real EXTERNAL change actually happen? Proxy: readback mismatches/day.
const rb = await prisma.cronRun.findMany({
  where: { jobName: 'amazon-qty-readback', status: 'SUCCESS' },
  select: { startedAt: true, outputSummary: true }, orderBy: { startedAt: 'desc' }, take: 7,
})
console.log('\nreal external-drift events actually seen per day (readback mismatches):')
for (const r of rb) console.log(`  ${r.startedAt.toISOString().slice(0, 10)}  ${String(r.outputSummary ?? '').slice(0, 90)}`)
await prisma.$disconnect()
