/** READ-ONLY: real-time order/cancel chain evidence, both channels. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const H = 3600e3

// Amazon orders today + ingest lag (createdAt − purchaseDate)
const orders = await prisma.order.findMany({
  where: { channel: 'AMAZON', createdAt: { gte: new Date(now - 24 * H) } },
  orderBy: { createdAt: 'desc' },
  take: 8,
  select: { channelOrderId: true, status: true, purchaseDate: true, createdAt: true, fulfillmentMethod: true },
})
console.log(`== AMAZON orders last 24h: ${orders.length} ==`)
for (const o of orders) {
  const lag = o.purchaseDate ? Math.round((o.createdAt.getTime() - o.purchaseDate.getTime()) / 60e3) : null
  console.log(`  ${o.channelOrderId} ${o.status} ${o.fulfillmentMethod} lag=${lag}min`)
}

// SQS delivery proof
const sqs = await prisma.cronRun.findMany({
  where: { jobName: 'amazon-sqs-poll', outputSummary: { contains: 'messages' } },
  orderBy: { startedAt: 'desc' },
  take: 5,
  select: { startedAt: true, outputSummary: true },
})
console.log(`== sqs ticks mentioning messages: ${sqs.length} ==`)
for (const s of sqs) console.log(`  ${s.startedAt.toISOString().slice(11, 19)} ${(s.outputSummary ?? '').slice(0, 100)}`)

// Post-fix outbound latency (1h window)
const rows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', syncedAt: { gte: new Date(now - 2 * H) }, syncStatus: 'SUCCESS' },
  select: { targetChannel: true, createdAt: true, syncedAt: true, holdUntil: true },
})
const lat = new Map<string, number[]>()
for (const r of rows) {
  const base = r.holdUntil && r.holdUntil > r.createdAt ? r.holdUntil : r.createdAt
  const ms = (r.syncedAt?.getTime() ?? 0) - base.getTime()
  const arr = lat.get(r.targetChannel) ?? []
  arr.push(ms)
  lat.set(r.targetChannel, arr)
}
console.log('== after-hold dispatch latency (successful rows, 2h) ==')
for (const [ch, arr] of lat) {
  arr.sort((a, b) => a - b)
  const p = (q: number) => Math.round(arr[Math.min(arr.length - 1, Math.floor((q / 100) * arr.length))] / 100) / 10
  console.log(`  ${ch}: n=${arr.length} p50=${p(50)}s p90=${p(90)}s max=${Math.round(arr[arr.length - 1] / 1000)}s`)
}

// Cancellation cascades (any ORDER_CANCELLED movements/rows recently?)
const cancels = await prisma.stockMovement.count({ where: { reason: 'ORDER_CANCELLED', createdAt: { gte: new Date(now - 7 * 24 * H) } } })
console.log(`ORDER_CANCELLED movements last 7d: ${cancels}`)
await prisma.$disconnect()
process.exit(0)
