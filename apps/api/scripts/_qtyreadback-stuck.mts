/** READ-ONLY: are the daily read-back mismatches the SAME rows every run (heal not sticking)? */
const { default: prisma } = await import('../src/db.js')

// Recent-only heal latency (last 7d) — the old rows rode the 403/circuit era.
const heals = await prisma.outboundSyncQueue.findMany({
  where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600e3) }, syncType: 'QUANTITY_UPDATE', targetChannel: 'AMAZON' },
  select: { id: true, createdAt: true, updatedAt: true, syncStatus: true, payload: true, targetRegion: true, channelListingId: true },
  orderBy: { createdAt: 'desc' },
  take: 8000,
})
const healRows = heals.filter((h) => (h.payload as { source?: string } | null)?.source === 'QTY_READBACK_HEAL')
const lags = healRows.filter((h) => h.syncStatus === 'SUCCESS').map((h) => (h.updatedAt.getTime() - h.createdAt.getTime()) / 1000).sort((a, b) => a - b)
if (lags.length) {
  const p = (q: number) => lags[Math.min(lags.length - 1, Math.floor(lags.length * q))].toFixed(0)
  console.log(`heal rows last 7d: ${healRows.length} · SUCCESS ${lags.length} · lag p50 ${p(0.5)}s p90 ${p(0.9)}s max ${lags[lags.length - 1].toFixed(0)}s`)
}

// Do the same SKUs mismatch day after day?
const logs = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_QTY_READBACK', channel: 'AMAZON', createdAt: { gte: new Date(Date.now() - 9 * 24 * 3600e3) } },
  select: { createdAt: true, errorMessage: true, productId: true, resolutionStatus: true },
  orderBy: { createdAt: 'desc' },
})
const perSku = new Map<string, { days: Set<string>; last: string; status: string }>()
for (const l of logs) {
  const m = /for ([^ ]+) \((\w+)\)/.exec(l.errorMessage ?? '')
  const key = m ? `${m[1]} ${m[2]}` : (l.errorMessage ?? '').slice(0, 40)
  const e = perSku.get(key) ?? { days: new Set<string>(), last: '', status: l.resolutionStatus }
  e.days.add(l.createdAt.toISOString().slice(0, 10))
  if (!e.last) e.last = (l.errorMessage ?? '').slice(0, 90)
  perSku.set(key, e)
}
const repeat = [...perSku.entries()].sort((a, b) => b[1].days.size - a[1].days.size)
console.log(`\ndistinct mismatch keys last 9d: ${repeat.length}`)
console.log('--- most-repeated (days seen) ---')
for (const [k, v] of repeat.slice(0, 14)) console.log(`  ${String(v.days.size).padStart(2)}d  ${v.status.padEnd(10)} ${v.last}`)

// For one repeat offender, show the listing + last publish attempts.
const worst = repeat[0]
if (worst) {
  const sku = worst[0].split(' ')[0]
  const mkt = worst[0].split(' ')[1]
  const cl = await prisma.channelListing.findFirst({
    where: { channel: 'AMAZON', marketplace: mkt, product: { sku } },
    select: {
      id: true, quantity: true, followMasterQuantity: true, syncPaused: true, offerClosedAt: true,
      isPublished: true, listingStatus: true, fulfillmentMethod: true, lastSyncStatus: true, lastSyncedAt: true,
      product: { select: { sku: true, fulfillmentMethod: true } },
    },
  })
  console.log(`\n--- ${sku} ${mkt} listing state ---`)
  console.log(JSON.stringify(cl, null, 1))
  if (cl) {
    const att = await prisma.channelPublishAttempt.findMany({
      where: { channelListingId: cl.id },
      orderBy: { createdAt: 'desc' }, take: 6,
      select: { createdAt: true, status: true, mode: true, errorMessage: true, requestPayload: true },
    }).catch(() => [])
    console.log('--- last publish attempts ---')
    for (const a of att as Array<{ createdAt: Date; status: string; mode: string | null; errorMessage: string | null }>) {
      console.log(`  ${a.createdAt.toISOString()} ${a.status} ${a.mode ?? ''} ${String(a.errorMessage ?? '').slice(0, 120)}`)
    }
  }
}
await prisma.$disconnect()
