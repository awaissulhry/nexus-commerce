/** READ-ONLY: AS-program final end-to-end verification snapshot. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const H = 3600e3

// 1) eBay orders — ingested? deducted?
const eo = await prisma.cronRun.findMany({ where: { jobName: 'ebay-orders-sync' }, orderBy: { startedAt: 'desc' }, take: 4, select: { startedAt: true, outputSummary: true } })
console.log('== ebay-orders-sync ==')
for (const r of eo) console.log(`  ${r.startedAt.toISOString().slice(11, 19)} ${(r.outputSummary ?? '').slice(0, 190)}`)
const orders = await prisma.order.findMany({
  where: { channel: 'EBAY' },
  orderBy: { createdAt: 'desc' },
  take: 6,
  select: { channelOrderId: true, status: true, totalPrice: true, currencyCode: true, purchaseDate: true, items: { select: { sku: true, quantity: true } } },
})
console.log(`== EBAY orders in DB: ${orders.length} ==`)
for (const o of orders) console.log(`  ${o.channelOrderId} ${o.status} ${o.totalPrice} ${o.currencyCode} purchased=${o.purchaseDate?.toISOString().slice(0, 16)} items=${o.items.map((i) => `${i.sku}x${i.quantity}`).join(',') || '(none)'}`)
const movements = await prisma.stockMovement.findMany({
  where: { reason: 'ORDER_PLACED', createdAt: { gte: new Date(now - 3 * H) } },
  orderBy: { createdAt: 'desc' },
  take: 8,
  select: { createdAt: true, change: true, balanceAfter: true, productId: true },
})
console.log(`== ORDER_PLACED movements last 3h: ${movements.length} ==`)
for (const m of movements) console.log(`  ${m.createdAt.toISOString().slice(11, 19)} ${m.productId} change=${m.change} after=${m.balanceAfter}`)

// 2) watchdog tripwires + auth rows
const wd = await prisma.cronRun.findFirst({ where: { jobName: 'latency-watchdog' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, outputSummary: true } })
console.log(`== latency-watchdog latest: ${wd?.startedAt.toISOString().slice(11, 19)} ${wd?.outputSummary ?? ''} ==`)
const auth = await prisma.syncHealthLog.findMany({ where: { conflictType: 'CHANNEL_AUTH_FAILURE' }, orderBy: { createdAt: 'desc' }, take: 2, select: { createdAt: true, channel: true, errorMessage: true } })
for (const a of auth) console.log(`  AUTH-TRIPWIRE ${a.createdAt.toISOString().slice(11, 19)} ${a.channel}: ${(a.errorMessage ?? '').slice(0, 110)}`)
if (!auth.length) console.log('  (no CHANNEL_AUTH_FAILURE rows yet)')

// 3) trading readback
const rb = await prisma.cronRun.findMany({ where: { jobName: 'ebay-readback' }, orderBy: { startedAt: 'desc' }, take: 2, select: { startedAt: true, outputSummary: true, errorMessage: true } })
console.log('== ebay-readback ==')
for (const r of rb) console.log(`  ${r.startedAt.toISOString().slice(11, 19)} ${(r.outputSummary ?? r.errorMessage ?? '').slice(0, 200)}`)
const ebayMismatch = await prisma.syncHealthLog.count({ where: { channel: 'EBAY', conflictType: 'CHANNEL_QTY_READBACK', createdAt: { gte: new Date(now - 3 * H) } } })
console.log(`  EBAY CHANNEL_QTY_READBACK rows last 3h: ${ebayMismatch}`)

// 4) amazon readback (directive run — pinned+markets live?)
for (const j of ['amazon-qty-readback', 'amazon-qty-readback-request']) {
  const r = await prisma.cronRun.findFirst({ where: { jobName: j }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, status: true, outputSummary: true, errorMessage: true } })
  console.log(`== ${j}: ${r?.startedAt.toISOString().slice(11, 19)} ${r?.status} ${(r?.outputSummary ?? r?.errorMessage ?? '').slice(0, 170)} ==`)
}

// 5) queue + attempts state
const codes = await prisma.outboundSyncQueue.groupBy({ by: ['errorCode'], where: { targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', syncStatus: 'FAILED', isDead: false }, _count: true })
console.log('== AMAZON parked by errorCode ==', codes.map((c) => `${c.errorCode ?? '-'}=${c._count}`).join(' '))
const att = await prisma.channelPublishAttempt.findMany({ where: { channel: 'AMAZON', outcome: { in: ['success', 'failed'] }, attemptedAt: { gte: new Date(now - 1.5 * H) } }, orderBy: { attemptedAt: 'desc' }, take: 4, select: { attemptedAt: true, outcome: true, sku: true, errorMessage: true } })
console.log('== AMAZON real attempts last 90min ==')
for (const a of att) console.log(`  ${a.attemptedAt.toISOString().slice(11, 19)} ${a.outcome.padEnd(7)} ${a.sku} ${(a.errorMessage ?? '').slice(0, 70)}`)

// 6) flip-guard + janitor + drift
for (const j of ['fba-flip-guard', 'outbound-queue-janitor', 'sync-drift-detection']) {
  const r = await prisma.cronRun.findFirst({ where: { jobName: j }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, outputSummary: true } })
  console.log(`== ${j}: ${r?.startedAt.toISOString().slice(11, 19)} ${(r?.outputSummary ?? '').slice(0, 130)} ==`)
}
const listings = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', isPublished: true, followMasterQuantity: true, NOT: { fulfillmentMethod: 'FBA' }, product: { NOT: { fulfillmentMethod: 'FBA' } } },
  select: { quantity: true, stockBuffer: true, product: { select: { totalStock: true } } },
})
let m = 0, d = 0, n = 0
for (const l of listings) {
  const intended = Math.max(0, (l.product?.totalStock ?? 0) - (l.stockBuffer ?? 0))
  if (l.quantity == null) n++
  else if (l.quantity === intended) m++
  else d++
}
console.log(`== DB drift snapshot (Amazon Following-FBM): ${listings.length} → match=${m} drift=${d} null=${n} ==`)

await prisma.$disconnect()
process.exit(0)
