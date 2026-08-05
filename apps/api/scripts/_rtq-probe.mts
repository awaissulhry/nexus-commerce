/** READ-ONLY: real-time quantity-sync probe — latency, follow/pin distribution, drift, reservations. */
const { default: prisma } = await import('../src/db.js')

const now = Date.now()
const d7 = new Date(now - 7 * 24 * 3600e3)
const pct = (arr: number[], p: number): number => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const secs = (ms: number) => Math.round(ms / 100) / 10

// ── 1. Outbound QUANTITY_UPDATE latency, last 7d ──────────────────────────
const qRows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', createdAt: { gte: d7 } },
  select: {
    targetChannel: true, syncStatus: true, createdAt: true, syncedAt: true,
    holdUntil: true, errorCode: true, isDead: true,
  },
})
const byCh: Record<string, { n: number; status: Record<string, number>; lat: number[]; held: number; deadN: number; stuckPending: number }> = {}
for (const r of qRows) {
  const ch = String(r.targetChannel)
  byCh[ch] ??= { n: 0, status: {}, lat: [], held: 0, deadN: 0, stuckPending: 0 }
  const b = byCh[ch]
  b.n++
  b.status[r.syncStatus] = (b.status[r.syncStatus] ?? 0) + 1
  if (r.holdUntil) b.held++
  if (r.isDead) b.deadN++
  if (r.syncStatus === 'PENDING' && now - r.createdAt.getTime() > 10 * 60e3) b.stuckPending++
  if (r.syncedAt) b.lat.push(r.syncedAt.getTime() - r.createdAt.getTime())
}
console.log('== 1. QUANTITY_UPDATE outbound, last 7d ==')
for (const [ch, b] of Object.entries(byCh)) {
  console.log(JSON.stringify({
    channel: ch, total: b.n, status: b.status, withHoldUntil: b.held, dead: b.deadN, stuckPendingOver10m: b.stuckPending,
    latencySec: b.lat.length
      ? { n: b.lat.length, min: secs(Math.min(...b.lat)), p50: secs(pct(b.lat, 50)), p90: secs(pct(b.lat, 90)), p99: secs(pct(b.lat, 99)), max: secs(Math.max(...b.lat)) }
      : null,
  }))
}
const under40 = qRows.filter((r) => r.syncedAt && r.syncedAt.getTime() - r.createdAt.getTime() < 40e3).length
const synced = qRows.filter((r) => r.syncedAt).length
console.log(JSON.stringify({ syncedTotal: synced, under40s: under40 }))

// ── 2. Listing distribution: follow/pinned/buffer/FBA ─────────────────────
const listings = await prisma.channelListing.findMany({
  where: { channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] } },
  select: {
    id: true, channel: true, marketplace: true, listingStatus: true,
    followMasterQuantity: true, quantityOverride: true, quantity: true,
    stockBuffer: true, fulfillmentMethod: true, offerActive: true, isPublished: true,
    productId: true,
    product: { select: { sku: true, fulfillmentMethod: true, totalStock: true } },
  },
})
type Cl = (typeof listings)[number]
const isFbaApprox = (l: Cl) =>
  l.channel === 'AMAZON' && ((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA'))
const dist: Record<string, { total: number; active: number; fba: number; fbmFollow: number; fbmPinned: number; bufferSet: number }> = {}
for (const l of listings) {
  const k = `${l.channel}:${l.marketplace}`
  dist[k] ??= { total: 0, active: 0, fba: 0, fbmFollow: 0, fbmPinned: 0, bufferSet: 0 }
  const d = dist[k]
  d.total++
  if (l.listingStatus === 'ACTIVE') d.active++
  if (isFbaApprox(l)) d.fba++
  else if (l.followMasterQuantity) d.fbmFollow++
  else d.fbmPinned++
  if ((l.stockBuffer ?? 0) > 0) d.bufferSet++
}
console.log('== 2. Listing distribution (FBA approx = listing.fm=FBA || product.fm=FBA) ==')
for (const [k, d] of Object.entries(dist).sort()) console.log(k, JSON.stringify(d))

// ── 3. Drift: ACTIVE FBM listings vs pool−buffer ──────────────────────────
const pools = await prisma.stockLevel.groupBy({
  by: ['productId'],
  where: { location: { type: 'WAREHOUSE' } },
  _sum: { available: true, quantity: true, reserved: true },
})
const poolByProduct = new Map(pools.map((p) => [p.productId, p._sum.available ?? 0]))
let followDrift = 0, followOk = 0, followNullQty = 0
let pinnedDiverged = 0, pinnedAtPool = 0
const driftSamples: unknown[] = []
for (const l of listings) {
  if (l.listingStatus !== 'ACTIVE' || isFbaApprox(l)) continue
  const avail = poolByProduct.get(l.productId) ?? 0
  const expected = Math.max(0, avail - (l.stockBuffer ?? 0))
  if (l.followMasterQuantity) {
    if (l.quantity == null) { followNullQty++; continue }
    if (l.quantity !== expected) {
      followDrift++
      if (driftSamples.length < 15) driftSamples.push({ sku: l.product?.sku, ch: l.channel, mp: l.marketplace, qty: l.quantity, expected, poolAvail: avail, buffer: l.stockBuffer })
    } else followOk++
  } else {
    const eff = l.quantityOverride ?? l.quantity
    if (eff != null && eff !== expected) pinnedDiverged++
    else pinnedAtPool++
  }
}
console.log('== 3. Drift (ACTIVE FBM) ==')
console.log(JSON.stringify({ followOk, followDrift, followNullQty, pinnedAtPool, pinnedDiverged }))
for (const s of driftSamples) console.log('DRIFT', JSON.stringify(s))

// ── 4. Reservations hygiene ───────────────────────────────────────────────
const resv = await prisma.stockReservation.findMany({
  where: { releasedAt: null, consumedAt: null },
  select: { reason: true, kind: true, quantity: true, createdAt: true, expiresAt: true },
})
const byReason: Record<string, { n: number; units: number; expiredUnreleased: number; over30d: number }> = {}
for (const r of resv) {
  byReason[r.reason] ??= { n: 0, units: 0, expiredUnreleased: 0, over30d: 0 }
  const b = byReason[r.reason]
  b.n++; b.units += r.quantity
  if (r.expiresAt.getTime() < now) b.expiredUnreleased++
  if (now - r.createdAt.getTime() > 30 * 24 * 3600e3) b.over30d++
}
console.log('== 4. Open reservations ==')
console.log(JSON.stringify(byReason))

// ── 5. Pool coverage sanity ───────────────────────────────────────────────
const prods = await prisma.product.findMany({ where: { totalStock: { gt: 0 } }, select: { id: true, sku: true, totalStock: true } })
const noLedger = prods.filter((p) => !poolByProduct.has(p.id))
console.log('== 5. Products with totalStock>0 but NO warehouse StockLevel rows ==')
console.log(JSON.stringify({ count: noLedger.length, sample: noLedger.slice(0, 8).map((p) => `${p.sku}:${p.totalStock}`) }))

// ── 6. Recent stock-movement drivers (48h) ────────────────────────────────
const mv = await prisma.stockMovement.groupBy({
  by: ['reason'],
  where: { createdAt: { gte: new Date(now - 48 * 3600e3) } },
  _count: { _all: true },
})
console.log('== 6. StockMovement reasons, last 48h ==')
console.log(JSON.stringify(mv.map((m) => ({ reason: m.reason, n: m._count._all }))))

await prisma.$disconnect()
process.exit(0)
