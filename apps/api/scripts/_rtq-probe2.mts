/** READ-ONLY: probe 2 — eBay failures, holdUntil grace, order-ingest lag, null-qty + no-ledger blast radius. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const d7 = new Date(now - 7 * 24 * 3600e3)
const pct = (arr: number[], p: number): number => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const secs = (ms: number) => Math.round(ms / 100) / 10

// ── A. eBay FAILED breakdown + eventual-success check ─────────────────────
const ebayRows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', targetChannel: 'EBAY', createdAt: { gte: d7 } },
  select: { id: true, channelListingId: true, syncStatus: true, errorCode: true, errorMessage: true, retryCount: true, createdAt: true, syncedAt: true },
  orderBy: { createdAt: 'asc' },
})
const failed = ebayRows.filter((r) => r.syncStatus === 'FAILED')
const codeCounts: Record<string, number> = {}
const msgCounts: Record<string, number> = {}
for (const f of failed) {
  codeCounts[f.errorCode ?? 'null'] = (codeCounts[f.errorCode ?? 'null'] ?? 0) + 1
  const m = (f.errorMessage ?? 'null').slice(0, 120)
  msgCounts[m] = (msgCounts[m] ?? 0) + 1
}
let failedThenSucceeded = 0
for (const f of failed) {
  if (ebayRows.some((r) => r.syncStatus === 'SUCCESS' && r.channelListingId === f.channelListingId && r.createdAt > f.createdAt)) failedThenSucceeded++
}
console.log('== A. eBay FAILED (7d) ==')
console.log(JSON.stringify({ failed: failed.length, byErrorCode: codeCounts, failedThenLaterSuccessOnSameListing: failedThenSucceeded }))
for (const [m, n] of Object.entries(msgCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  [${n}x] ${m}`)
const retryDist: Record<string, number> = {}
for (const f of failed) retryDist[String(f.retryCount)] = (retryDist[String(f.retryCount)] ?? 0) + 1
console.log('  retryCount dist:', JSON.stringify(retryDist))

// ── B. holdUntil grace distribution ───────────────────────────────────────
const allQ = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', createdAt: { gte: d7 }, holdUntil: { not: null } },
  select: { targetChannel: true, createdAt: true, holdUntil: true },
})
const holdByCh: Record<string, number[]> = {}
for (const r of allQ) {
  const ch = String(r.targetChannel)
  ;(holdByCh[ch] ??= []).push(r.holdUntil!.getTime() - r.createdAt.getTime())
}
console.log('== B. holdUntil − createdAt (grace) ==')
for (const [ch, arr] of Object.entries(holdByCh)) {
  console.log(`  ${ch}: n=${arr.length} min=${secs(Math.min(...arr))}s p50=${secs(pct(arr, 50))}s max=${secs(Math.max(...arr))}s`)
}

// ── C. payload samples (origin forensics) ─────────────────────────────────
for (const ch of ['AMAZON', 'EBAY'] as const) {
  const samples = await prisma.outboundSyncQueue.findMany({
    where: { syncType: 'QUANTITY_UPDATE', targetChannel: ch, createdAt: { gte: d7 } },
    orderBy: { createdAt: 'desc' }, take: 3,
    select: { createdAt: true, targetRegion: true, payload: true, syncStatus: true },
  })
  console.log(`== C. ${ch} payload samples ==`)
  for (const s of samples) console.log(`  ${s.createdAt.toISOString()} ${s.targetRegion} ${s.syncStatus} ${JSON.stringify(s.payload).slice(0, 260)}`)
}

// ── D. Order ingestion lag (createdAt − purchaseDate), last 7d ────────────
const orders = await prisma.order.findMany({
  where: { createdAt: { gte: d7 } },
  select: { channel: true, marketplace: true, status: true, purchaseDate: true, createdAt: true, fulfillmentMethod: true },
})
const lagByCh: Record<string, { n: number; lags: number[]; fm: Record<string, number> }> = {}
for (const o of orders) {
  const ch = String(o.channel)
  lagByCh[ch] ??= { n: 0, lags: [], fm: {} }
  lagByCh[ch].n++
  lagByCh[ch].fm[o.fulfillmentMethod ?? 'null'] = (lagByCh[ch].fm[o.fulfillmentMethod ?? 'null'] ?? 0) + 1
  if (o.purchaseDate) lagByCh[ch].lags.push(o.createdAt.getTime() - o.purchaseDate.getTime())
}
console.log('== D. Orders last 7d: ingest lag (rowCreated − purchase) ==')
for (const [ch, b] of Object.entries(lagByCh)) {
  const l = b.lags
  console.log(`  ${ch}: n=${b.n} fm=${JSON.stringify(b.fm)} lagMin: min=${l.length ? Math.round(Math.min(...l) / 60e3) : '-'} p50=${l.length ? Math.round(pct(l, 50) / 60e3) : '-'} p90=${l.length ? Math.round(pct(l, 90) / 60e3) : '-'} max=${l.length ? Math.round(Math.max(...l) / 60e3) : '-'}`)
}

// ── E. Following-with-null-qty breakdown ──────────────────────────────────
const nullQty = await prisma.channelListing.findMany({
  where: { channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] }, listingStatus: 'ACTIVE', followMasterQuantity: true, quantity: null },
  select: { channel: true, marketplace: true, fulfillmentMethod: true, product: { select: { fulfillmentMethod: true } } },
})
const nq: Record<string, number> = {}
for (const l of nullQty) {
  const fba = l.channel === 'AMAZON' && ((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA'))
  const k = `${l.channel}:${l.marketplace}:${fba ? 'FBA' : 'FBM'}`
  nq[k] = (nq[k] ?? 0) + 1
}
console.log('== E. ACTIVE Following listings with quantity=null ==')
console.log(JSON.stringify(nq))

// ── F. No-ledger products: blast radius ───────────────────────────────────
const pools = await prisma.stockLevel.groupBy({ by: ['productId'], where: { location: { type: 'WAREHOUSE' } }, _sum: { available: true } })
const pooled = new Set(pools.map((p) => p.productId))
const prods = await prisma.product.findMany({ where: { totalStock: { gt: 0 } }, select: { id: true, sku: true, totalStock: true } })
const noLedger = prods.filter((p) => !pooled.has(p.id))
const nlIds = noLedger.map((p) => p.id)
const nlListings = await prisma.channelListing.findMany({
  where: { productId: { in: nlIds }, listingStatus: 'ACTIVE' },
  select: { channel: true, marketplace: true, followMasterQuantity: true, quantity: true },
})
const nlDist: Record<string, { n: number; following: number; qtySum: number }> = {}
for (const l of nlListings) {
  const k = `${l.channel}:${l.marketplace}`
  nlDist[k] ??= { n: 0, following: 0, qtySum: 0 }
  nlDist[k].n++
  if (l.followMasterQuantity) nlDist[k].following++
  nlDist[k].qtySum += l.quantity ?? 0
}
console.log('== F. No-ledger products (totalStock>0, no WAREHOUSE rows) ==')
console.log(JSON.stringify({ products: noLedger.length, activeListings: nlListings.length, byChannel: nlDist }))
const parents = new Map<string, number>()
for (const p of noLedger) parents.set(p.sku.split('-')[0], (parents.get(p.sku.split('-')[0]) ?? 0) + 1)
console.log('  families:', JSON.stringify([...parents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)))

await prisma.$disconnect()
process.exit(0)
