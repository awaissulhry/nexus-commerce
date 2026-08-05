/** READ-ONLY: anomaly drill-down for the pool→Amazon sync study. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const H = 3600e3

// 1) FBA flip-guard verification — queue SUCCESS rows for FBA-signal SKUs vs REAL attempts
const flip = await prisma.$queryRaw<{ sku: string | null; mp: string | null; createdat: Date }[]>`
  SELECT p.sku AS sku, cl.marketplace AS mp, q."createdAt" AS createdat
  FROM "OutboundSyncQueue" q
  JOIN "ChannelListing" cl ON cl.id = q."channelListingId"
  JOIN "Product" p ON p.id = cl."productId"
  WHERE q."targetChannel" = 'AMAZON' AND q."syncType" = 'QUANTITY_UPDATE' AND q."syncStatus" = 'SUCCESS'
    AND q."createdAt" > now() - interval '120 minutes'
    AND (
      cl."fulfillmentMethod"::text = 'FBA' OR p."fulfillmentMethod"::text = 'FBA'
      OR EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id = sl."locationId"
                 WHERE sl."productId" = cl."productId" AND loc.code = 'AMAZON-EU-FBA' AND sl.quantity > 0)
      OR EXISTS (SELECT 1 FROM "Offer" o WHERE o."channelListingId" = cl.id AND o."fulfillmentMethod"::text = 'FBA' AND o."isActive")
    )`
const flipSkus = [...new Set(flip.map((f) => f.sku).filter(Boolean))] as string[]
console.log(`== FBA-signal queue-SUCCESS rows last 120m: ${flip.length} rows, skus: ${flipSkus.join(', ')} ==`)
if (flipSkus.length) {
  const att = await prisma.channelPublishAttempt.findMany({
    where: { channel: 'AMAZON', sku: { in: flipSkus }, attemptedAt: { gte: new Date(now - 2 * H) } },
    select: { sku: true, marketplace: true, outcome: true, mode: true, attemptedAt: true, errorMessage: true },
    orderBy: { attemptedAt: 'desc' },
  })
  const agg: Record<string, number> = {}
  for (const a of att) agg[`${a.mode}/${a.outcome}`] = (agg[`${a.mode}/${a.outcome}`] ?? 0) + 1
  console.log(`  attempts for those SKUs last 2h: ${att.length}`, JSON.stringify(agg))
  for (const a of att.slice(0, 10)) console.log(`    ${a.attemptedAt.toISOString().slice(11, 19)} ${a.sku}@${a.marketplace} ${a.mode}/${a.outcome} ${(a.errorMessage ?? '').slice(0, 80)}`)
}

// 2) REAL Amazon failures last 3h (not circuit-open noise)
const failed = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', outcome: 'failed', attemptedAt: { gte: new Date(now - 3 * H) } },
  orderBy: { attemptedAt: 'desc' },
  take: 20,
  select: { attemptedAt: true, sku: true, marketplace: true, errorMessage: true, errorCode: true },
})
console.log(`== live/failed attempts last 3h: ${failed.length} ==`)
for (const f of failed) console.log(`  ${f.attemptedAt.toISOString().slice(11, 19)} ${f.sku}@${f.marketplace} [${f.errorCode ?? '-'}] ${(f.errorMessage ?? '').slice(0, 200)}`)

// 3) ebay-orders-sync failure detail
const eo = await prisma.cronRun.findMany({ where: { jobName: 'ebay-orders-sync' }, orderBy: { startedAt: 'desc' }, take: 3 })
console.log('== ebay-orders-sync last 3 runs ==')
for (const r of eo) console.log(`  ${r.startedAt.toISOString().slice(11, 19)} ${r.status} — ${(r.outputSummary ?? '').slice(0, 160)} ${r.errorMessage ? 'ERR=' + r.errorMessage.slice(0, 220) : ''}`)

// 4) SyncHealthLog samples (breach/readback/auth)
for (const ct of ['LATENCY_BREACH', 'CHANNEL_QTY_READBACK', 'CHANNEL_AUTH_FAILURE', 'PUBLISH_FAILURE_RATE']) {
  const rows = await prisma.syncHealthLog.findMany({
    where: { conflictType: ct, createdAt: { gte: new Date(now - 24 * H) } },
    orderBy: { createdAt: 'desc' },
    take: 4,
    select: { createdAt: true, channel: true, errorMessage: true, conflictData: true, severity: true },
  })
  console.log(`== SyncHealthLog ${ct}: ${rows.length} (last 24h, showing ≤4) ==`)
  for (const r of rows)
    console.log(`  ${r.createdAt.toISOString().slice(11, 19)} ${r.channel} ${r.severity} ${(r.errorMessage ?? '').slice(0, 140)} ${JSON.stringify(r.conflictData ?? {}).slice(0, 160)}`)
}

// 5) amazon-sqs-poll completed ticks — delivery proof (messages=N)
const sqs = await prisma.cronRun.findMany({
  where: { jobName: 'amazon-sqs-poll', status: { not: 'RUNNING' } },
  orderBy: { startedAt: 'desc' },
  take: 6,
  select: { startedAt: true, status: true, outputSummary: true },
})
console.log('== amazon-sqs-poll last completed ticks ==')
for (const s of sqs) console.log(`  ${s.startedAt.toISOString().slice(11, 19)} ${s.status} ${(s.outputSummary ?? '').slice(0, 140)}`)

await prisma.$disconnect()
process.exit(0)
