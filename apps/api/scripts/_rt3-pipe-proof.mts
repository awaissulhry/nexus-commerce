/** RT.3 — end-to-end pipe proof: net-zero ±1 movement → offer change → expect
 *  ANY_OFFER_CHANGED delivery into the queue (visible as messages>0 in the
 *  sqs-poll CronRun summaries). Restores stock exactly; pushes are the same
 *  net-zero pattern as the RT.1 canary. */
const { default: prisma } = await import('../src/db.js')
const { applyStockMovement } = await import('../src/services/stock-movement.service.js')

const SKU = 'WATERPROOF-OVERJACKET-BLACK-MEN-3XL'
const p = await prisma.product.findUnique({ where: { sku: SKU }, select: { id: true, totalStock: true } })
if (!p) { console.log('product not found'); process.exit(1) }
console.log(`canary ${SKU}: totalStock=${p.totalStock} → +1 → −1`)

await applyStockMovement({ productId: p.id, change: 1, reason: 'MANUAL_ADJUSTMENT', notes: 'RT.3 pipe proof +1 (net-zero)' , actor: 'rt3-pipe-proof' })
await new Promise((r) => setTimeout(r, 5_000))
await applyStockMovement({ productId: p.id, change: -1, reason: 'MANUAL_ADJUSTMENT', notes: 'RT.3 pipe proof −1 (net-zero)', actor: 'rt3-pipe-proof' })
const after = await prisma.product.findUnique({ where: { id: p.id }, select: { totalStock: true } })
console.log(`restored: totalStock=${after?.totalStock} (expect ${p.totalStock})`)

console.log('watching sqs-poll for message arrivals (up to 15 min)…')
const t0 = Date.now()
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 60_000))
  const runs = await prisma.cronRun.findMany({
    where: { jobName: 'amazon-sqs-poll', startedAt: { gte: new Date(t0 - 60_000) } },
    orderBy: { startedAt: 'desc' },
    take: 3,
    select: { startedAt: true, outputSummary: true },
  })
  const withMsgs = runs.filter((r) => r.outputSummary && !r.outputSummary.includes('no messages'))
  console.log(`  t+${i + 1}min: ${runs[0]?.outputSummary ?? '…'}`)
  if (withMsgs.length) {
    console.log(`  🎉 MESSAGES ARRIVED: ${withMsgs.map((r) => `${r.startedAt.toISOString().slice(11, 19)} ${r.outputSummary}`).join(' | ')}`)
    break
  }
}
await prisma.$disconnect()
process.exit(0)
