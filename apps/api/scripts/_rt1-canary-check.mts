/** READ-ONLY: verify canary rows + net-zero restore for WATERPROOF 3XL. */
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findUnique({
  where: { sku: 'WATERPROOF-OVERJACKET-BLACK-MEN-3XL' },
  select: { id: true, totalStock: true },
})
console.log(`totalStock now: ${p?.totalStock}`)
const moves = await prisma.stockMovement.findMany({
  where: { productId: p!.id, createdAt: { gte: new Date(Date.now() - 30 * 60e3) } },
  select: { change: true, reason: true, balanceAfter: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
})
for (const m of moves) console.log(`  move ${m.createdAt.toISOString().slice(11, 19)} ${m.change > 0 ? '+' : ''}${m.change} ${m.reason} balance=${m.balanceAfter}`)
const rows = await prisma.outboundSyncQueue.findMany({
  where: { productId: p!.id, createdAt: { gte: new Date(Date.now() - 30 * 60e3) } },
  select: { targetChannel: true, syncStatus: true, createdAt: true, syncedAt: true, holdUntil: true, payload: true },
  orderBy: { createdAt: 'asc' },
})
const secs = (ms: number) => Math.round(ms / 100) / 10
for (const r of rows) {
  const lat = r.syncedAt ? secs(r.syncedAt.getTime() - r.createdAt.getTime()) : null
  const ah = r.syncedAt && r.holdUntil ? secs(r.syncedAt.getTime() - r.holdUntil.getTime()) : null
  const q = (r.payload as { quantity?: number } | null)?.quantity
  console.log(`  row ${r.createdAt.toISOString().slice(11, 19)} ${r.targetChannel} ${r.syncStatus} qty=${q} latency=${lat ?? '-'}s afterHold=${ah ?? '-'}s`)
}
await prisma.$disconnect()
process.exit(0)
