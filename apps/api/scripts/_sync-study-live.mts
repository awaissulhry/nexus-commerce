/** READ-ONLY: consolidated live-state snapshot for the pool→Amazon sync study (2026-07-20). */
const { default: prisma } = await import('../src/db.js')
const H = 3600e3
const now = Date.now()

// 1) Amazon publish attempts — is the 403 still standing?
const attempts = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', attemptedAt: { gte: new Date(now - 6 * H) } },
  orderBy: { attemptedAt: 'desc' },
  select: { outcome: true, mode: true, errorMessage: true, attemptedAt: true, sku: true, marketplace: true },
})
const byOutcome: Record<string, number> = {}
for (const a of attempts) byOutcome[`${a.mode}/${a.outcome}`] = (byOutcome[`${a.mode}/${a.outcome}`] ?? 0) + 1
console.log(`== AMAZON ChannelPublishAttempt last 6h: ${attempts.length} ==`, JSON.stringify(byOutcome))
const lastOk = attempts.find((a) => a.outcome === 'success')
console.log(`  last success: ${lastOk ? `${lastOk.attemptedAt.toISOString()} ${lastOk.sku}@${lastOk.marketplace}` : 'NONE in 6h'}`)
const errSeen = new Set<string>()
for (const a of attempts.filter((x) => x.errorMessage)) {
  const key = (a.errorMessage ?? '').slice(0, 70)
  if (errSeen.has(key) || errSeen.size >= 5) continue
  errSeen.add(key)
  console.log(`  err@${a.attemptedAt.toISOString().slice(11, 19)} ${a.sku}@${a.marketplace}: ${(a.errorMessage ?? '').slice(0, 180)}`)
}

// 2) Queue state — the parked wave
const chans = ['AMAZON', 'EBAY'] as const
for (const ch of chans) {
  const grp = await prisma.outboundSyncQueue.groupBy({
    by: ['syncStatus'],
    where: { targetChannel: ch as never, syncType: 'QUANTITY_UPDATE', createdAt: { gte: new Date(now - 24 * H) } },
    _count: true,
  })
  console.log(`== ${ch} QUANTITY_UPDATE rows last 24h ==`, grp.map((g) => `${g.syncStatus}=${g._count}`).join(' '))
}
const pendingAll = await prisma.outboundSyncQueue.findMany({
  where: { targetChannel: 'AMAZON', syncStatus: { in: ['PENDING', 'IN_PROGRESS'] } },
  select: { createdAt: true, errorCode: true, syncType: true },
  orderBy: { createdAt: 'asc' },
})
const oldest = pendingAll[0]
const deferred = pendingAll.filter((r) => r.errorCode === 'CIRCUIT_OPEN_DEFERRED').length
console.log(`== AMAZON open rows (all-time): ${pendingAll.length} (deferred-marked=${deferred}) oldest=${oldest ? oldest.createdAt.toISOString() : '-'} ==`)

// 3) Latest run per cron job (distinct trick)
const cronLatest = await prisma.cronRun.findMany({
  distinct: ['jobName'],
  orderBy: { startedAt: 'desc' },
  select: { jobName: true, status: true, startedAt: true, outputSummary: true, errorMessage: true },
})
console.log('== latest CronRun per job (sync-relevant) ==')
const want = /amazon|ebay|sync|janitor|latency|reconcile|drift|reservation|fba|outbound/i
for (const c of cronLatest.filter((c) => want.test(c.jobName)).sort((a, b) => a.jobName.localeCompare(b.jobName))) {
  const age = Math.round((now - c.startedAt.getTime()) / 60e3)
  console.log(`  ${c.jobName.padEnd(34)} ${c.status.padEnd(8)} ${age}m ago — ${(c.outputSummary ?? c.errorMessage ?? '').slice(0, 140)}`)
}

// 4) SQS poll delivery proof — messages= in recent summaries
const sqs = await prisma.cronRun.findMany({
  where: { jobName: 'amazon-sqs-poll' },
  orderBy: { startedAt: 'desc' },
  take: 8,
  select: { startedAt: true, status: true, outputSummary: true },
})
console.log('== amazon-sqs-poll recent ticks ==')
for (const s of sqs) console.log(`  ${s.startedAt.toISOString().slice(11, 19)} ${s.status} ${(s.outputSummary ?? '').slice(0, 120)}`)

// 5) SyncHealthLog last 24h by type
const health = await prisma.syncHealthLog.groupBy({
  by: ['conflictType'],
  where: { createdAt: { gte: new Date(now - 24 * H) } },
  _count: true,
})
console.log('== SyncHealthLog last 24h ==', health.map((h) => `${h.conflictType}=${h._count}`).join(' ') || '(none)')
const authFail = await prisma.syncHealthLog.findFirst({
  where: { conflictType: 'CHANNEL_AUTH_FAILURE' },
  orderBy: { createdAt: 'desc' },
})
if (authFail) console.log(`  latest CHANNEL_AUTH_FAILURE: ${authFail.createdAt.toISOString()} ${JSON.stringify(authFail.details ?? {}).slice(0, 200)}`)

// 6) Drift snapshot: Following published Amazon FBM listings vs pool (approx: totalStock − buffer; ignores reservations)
const listings = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON',
    isPublished: true,
    followMasterQuantity: true,
    NOT: { fulfillmentMethod: 'FBA' },
    product: { NOT: { fulfillmentMethod: 'FBA' } },
  },
  select: {
    quantity: true,
    stockBuffer: true,
    marketplace: true,
    product: { select: { sku: true, totalStock: true } },
  },
})
let match = 0
let drift = 0
let nullq = 0
const driftSamples: string[] = []
for (const l of listings) {
  const intended = Math.max(0, (l.product?.totalStock ?? 0) - (l.stockBuffer ?? 0))
  if (l.quantity === null || l.quantity === undefined) {
    nullq++
    continue
  }
  if (l.quantity === intended) match++
  else {
    drift++
    if (driftSamples.length < 8) driftSamples.push(`${l.product?.sku}@${l.marketplace} listing=${l.quantity} intended=${intended}`)
  }
}
console.log(`== Amazon Following-FBM published listings: ${listings.length} → match=${match} drift=${drift} null=${nullq} ==`)
for (const d of driftSamples) console.log(`  drift: ${d}`)

// 7) eBay contrast — same drift math over eBay listings
const eb = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', isPublished: true, followMasterQuantity: true, NOT: { fulfillmentMethod: 'FBA' } },
  select: { quantity: true, stockBuffer: true, product: { select: { totalStock: true } } },
})
let em = 0
let ed = 0
let en = 0
for (const l of eb) {
  const intended = Math.max(0, (l.product?.totalStock ?? 0) - (l.stockBuffer ?? 0))
  if (l.quantity === null) en++
  else if (l.quantity === intended) em++
  else ed++
}
console.log(`== eBay Following published listings: ${eb.length} → match=${em} drift=${ed} null=${en} ==`)

await prisma.$disconnect()
process.exit(0)
