/** READ-ONLY: final live-state probe for the pool→Amazon sync study. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const H = 3600e3

// 1) eBay getOrders failure — actual error from the API call log
const calls = await prisma.outboundApiCallLog.findMany({
  where: { channel: 'EBAY', operation: 'getOrders' },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { createdAt: true, statusCode: true, success: true, errorMessage: true, errorCode: true },
})
console.log('== EBAY getOrders recent calls ==')
for (const c of calls) console.log(`  ${c.createdAt.toISOString().slice(5, 19)} ok=${c.success} http=${c.statusCode} [${c.errorCode ?? '-'}] ${(c.errorMessage ?? '').slice(0, 220)}`)

// 2) since when failing — daily ok/failed for ebay-orders-sync
const eoRuns = await prisma.cronRun.findMany({
  where: { jobName: 'ebay-orders-sync', startedAt: { gte: new Date(now - 7 * 24 * H) } },
  select: { startedAt: true, outputSummary: true },
  orderBy: { startedAt: 'asc' },
})
const byDay = new Map<string, { ok: number; fail: number }>()
for (const r of eoRuns) {
  const d = r.startedAt.toISOString().slice(0, 10)
  const b = byDay.get(d) ?? { ok: 0, fail: 0 }
  if (/failed=0/.test(r.outputSummary ?? '')) b.ok++
  else b.fail++
  byDay.set(d, b)
}
console.log('== ebay-orders-sync daily (ok-runs / failed-runs) ==')
for (const [d, b] of byDay) console.log(`  ${d}: ok=${b.ok} fail=${b.fail}`)

// 3) Amazon attempts hourly histogram last 26h (false-green era vs honest era)
const att = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', attemptedAt: { gte: new Date(now - 26 * H) }, outcome: { in: ['success', 'failed'] } },
  select: { attemptedAt: true, outcome: true, marketplace: true },
})
const hist = new Map<string, { ok: number; fail: number }>()
for (const a of att) {
  const h = a.attemptedAt.toISOString().slice(5, 13)
  const b = hist.get(h) ?? { ok: 0, fail: 0 }
  a.outcome === 'success' ? b.ok++ : b.fail++
  hist.set(h, b)
}
console.log('== AMAZON success/failed per hour (26h) ==')
for (const [h, b] of [...hist.entries()].sort()) console.log(`  ${h}h  ok=${String(b.ok).padEnd(5)} fail=${b.fail}`)

// 4) Amazon backlog that auto-delivers on auth fix
const backlog = await prisma.outboundSyncQueue.groupBy({
  by: ['syncStatus', 'errorCode'],
  where: { targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', isDead: false, syncStatus: { in: ['PENDING', 'FAILED', 'IN_PROGRESS'] } },
  _count: true,
})
console.log('== AMAZON live backlog (isDead=false) ==', backlog.map((b) => `${b.syncStatus}/${b.errorCode ?? '-'}=${b._count}`).join(' '))
const dead = await prisma.outboundSyncQueue.count({ where: { targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', isDead: true, diedAt: { gte: new Date(now - 24 * H) } } })
console.log(`   dead-lettered last 24h: ${dead}`)
const healRows = await prisma.outboundSyncQueue.groupBy({
  by: ['syncStatus'],
  where: { targetChannel: 'AMAZON', createdAt: { gte: new Date(now - 6 * H) }, payload: { path: ['source'], equals: 'QTY_READBACK_HEAL' } },
  _count: true,
})
console.log('   readback-heal rows (6h):', healRows.map((b) => `${b.syncStatus}=${b._count}`).join(' ') || '(none)')

// 5) Drift snapshot: Following published Amazon FBM listings vs pool
const listings = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON', isPublished: true, followMasterQuantity: true,
    NOT: { fulfillmentMethod: 'FBA' }, product: { NOT: { fulfillmentMethod: 'FBA' } },
  },
  select: { quantity: true, stockBuffer: true, marketplace: true, product: { select: { sku: true, totalStock: true } } },
})
let m = 0, d = 0, n = 0
const ds: string[] = []
for (const l of listings) {
  const intended = Math.max(0, (l.product?.totalStock ?? 0) - (l.stockBuffer ?? 0))
  if (l.quantity == null) n++
  else if (l.quantity === intended) m++
  else { d++; if (ds.length < 6) ds.push(`${l.product?.sku}@${l.marketplace} listing=${l.quantity} pool-intent=${intended}`) }
}
console.log(`== Amazon Following-FBM published: ${listings.length} → DB-match=${m} DB-drift=${d} null=${n} ==`)
for (const x of ds) console.log(`  drift: ${x}`)

// 6) eBay topology + drift contrast
const ebCount = await prisma.channelListing.count({ where: { channel: 'EBAY', isPublished: true } })
const memb = await prisma.sharedListingMembership.groupBy({ by: ['status'], _count: true })
const distinctItems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, distinct: ['itemId'], select: { itemId: true } })
console.log(`== eBay topology: publishedListings=${ebCount}, memberships=${memb.map((x) => `${x.status}=${x._count}`).join(' ')}, activeItemIds=${distinctItems.length} ==`)
const eb = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', isPublished: true, followMasterQuantity: true },
  select: { quantity: true, stockBuffer: true, product: { select: { totalStock: true } } },
})
let em = 0, ed = 0, en = 0
for (const l of eb) {
  const intended = Math.max(0, (l.product?.totalStock ?? 0) - (l.stockBuffer ?? 0))
  if (l.quantity == null) en++
  else if (l.quantity === intended) em++
  else ed++
}
console.log(`== eBay Following published: ${eb.length} → DB-match=${em} DB-drift=${ed} null=${en} ==`)

await prisma.$disconnect()
process.exit(0)
