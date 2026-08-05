/** READ-ONLY: is the owner's bulk import flowing to Amazon? */
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 30 * 60e3)
const moves = await prisma.stockMovement.findMany({
  where: { createdAt: { gte: since }, reason: { in: ['MANUAL_ADJUSTMENT', 'INVENTORY_COUNT', 'STOCKLEVEL_BACKFILL'] } },
  select: { createdAt: true, change: true, reason: true, referenceType: true, productId: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`stock movements last 30min: ${moves.length}`)
const prods = await prisma.product.findMany({
  where: { id: { in: [...new Set(moves.map((m) => m.productId))] } },
  select: { id: true, sku: true },
})
const skuBy = new Map(prods.map((p) => [p.id, p.sku]))
const fam = (s: string) => (s.match(/^([A-Za-z]+)/)?.[1] ?? s).toUpperCase()
const mf = new Map<string, number>()
for (const m of moves) mf.set(fam(skuBy.get(m.productId) ?? '?'), (mf.get(fam(skuBy.get(m.productId) ?? '?')) ?? 0) + 1)
console.log('  by family:', JSON.stringify([...mf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)))
if (moves.length) console.log(`  window: ${moves[moves.length - 1].createdAt.toISOString().slice(11, 19)} → ${moves[0].createdAt.toISOString().slice(11, 19)} UTC`)

const rows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', createdAt: { gte: since } },
  select: { targetChannel: true, syncStatus: true, createdAt: true, syncedAt: true, payload: true, channelListing: { select: { product: { select: { sku: true } }, marketplace: true } } },
})
const agg: Record<string, number> = {}
const lats: number[] = []
for (const r of rows) {
  agg[`${r.targetChannel}:${r.syncStatus}`] = (agg[`${r.targetChannel}:${r.syncStatus}`] ?? 0) + 1
  if (r.syncedAt) lats.push(r.syncedAt.getTime() - r.createdAt.getTime())
}
lats.sort((a, b) => a - b)
console.log(`push rows last 30min: ${rows.length} → ${JSON.stringify(agg)}`)
if (lats.length) console.log(`  delivery latency: p50=${Math.round(lats[Math.floor(lats.length / 2)] / 1000)}s max=${Math.round(lats[lats.length - 1] / 1000)}s`)
const succ = rows.filter((r) => r.syncStatus === 'SUCCESS' && r.targetChannel === 'AMAZON' && Number((r.payload as { quantity?: number } | null)?.quantity ?? 0) > 0).slice(0, 6)
for (const s of succ) console.log(`  ✓ ${s.channelListing?.product?.sku}@${s.channelListing?.marketplace} qty=${(s.payload as { quantity?: number } | null)?.quantity}`)
await prisma.$disconnect()
process.exit(0)
