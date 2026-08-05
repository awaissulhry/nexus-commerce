/** READ-ONLY: probe 3 — membership hygiene, backlog dynamics, burst drain rate. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const d7 = new Date(now - 7 * 24 * 3600e3)

// ── A. SharedListingMembership hygiene ────────────────────────────────────
const mems = await prisma.sharedListingMembership.findMany({
  select: { id: true, itemId: true, marketplace: true, sku: true, status: true, productId: true, lastQtyPushed: true, updatedAt: true },
})
const byItem = new Map<string, { n: number; status: Set<string>; mp: string }>()
for (const m of mems) {
  const b = byItem.get(m.itemId) ?? { n: 0, status: new Set<string>(), mp: m.marketplace }
  b.n++; b.status.add(m.status)
  byItem.set(m.itemId, b)
}
console.log('== A. SharedListingMembership ==')
console.log(JSON.stringify({ totalRows: mems.length, distinctItemIds: byItem.size, byStatus: mems.reduce((a: Record<string, number>, m) => { a[m.status] = (a[m.status] ?? 0) + 1; return a }, {}) }))
for (const [item, b] of byItem) console.log(`  item ${item} mp=${b.mp} skus=${b.n} status=${[...b.status].join(',')}`)

// Which itemIds have FAILED quantity pushes in 7d?
const fails = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', targetChannel: 'EBAY', syncStatus: 'FAILED', createdAt: { gte: d7 }, externalListingId: { not: null } },
  select: { externalListingId: true, errorMessage: true },
})
const failByItem: Record<string, number> = {}
for (const f of fails) failByItem[f.externalListingId!] = (failByItem[f.externalListingId!] ?? 0) + 1
console.log('  FAILED rows by itemId (7d):', JSON.stringify(failByItem))

// ── B. Current backlog ────────────────────────────────────────────────────
const pending = await prisma.outboundSyncQueue.findMany({
  where: { syncStatus: { in: ['PENDING', 'IN_PROGRESS'] } },
  select: { syncType: true, targetChannel: true, createdAt: true, holdUntil: true, nextRetryAt: true },
})
console.log('== B. Current PENDING/IN_PROGRESS ==')
console.log(JSON.stringify({
  total: pending.length,
  byTypeChannel: pending.reduce((a: Record<string, number>, r) => { const k = `${r.syncType}:${r.targetChannel}`; a[k] = (a[k] ?? 0) + 1; return a }, {}),
  oldestAgeMin: pending.length ? Math.round((now - Math.min(...pending.map((r) => r.createdAt.getTime()))) / 60e3) : 0,
}))

// ── C. Burst drain dynamics: hourly created vs latency (7d, qty only) ─────
const rows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', createdAt: { gte: d7 } },
  select: { createdAt: true, syncedAt: true, syncStatus: true, targetChannel: true },
})
const buckets = new Map<string, { created: number; synced: number; lat: number[] }>()
for (const r of rows) {
  const h = new Date(Math.floor(r.createdAt.getTime() / 3600e3) * 3600e3).toISOString().slice(5, 13)
  const b = buckets.get(h) ?? { created: 0, synced: 0, lat: [] }
  b.created++
  if (r.syncedAt) { b.synced++; b.lat.push(r.syncedAt.getTime() - r.createdAt.getTime()) }
  buckets.set(h, b)
}
const top = [...buckets.entries()].sort((a, b) => b[1].created - a[1].created).slice(0, 8)
console.log('== C. Top-8 creation-burst hours: created / synced / p50 / max latency (min) ==')
const pct = (arr: number[], p: number) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
for (const [h, b] of top) {
  console.log(`  ${h}h created=${b.created} synced=${b.synced} p50=${b.lat.length ? Math.round(pct(b.lat, 50) / 60e3) : '-'}m max=${b.lat.length ? Math.round(Math.max(...b.lat) / 60e3) : '-'}m`)
}

await prisma.$disconnect()
process.exit(0)
