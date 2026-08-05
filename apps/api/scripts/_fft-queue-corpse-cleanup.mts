/** FFT.4 hotfix — one-time hygiene: CANCEL retry-exhausted FAILED queue rows
 *  from the pre-launch "AMAZON publishing is disabled (gated)" era (June).
 *  They can never run (retries exhausted, the gate is long open, current truth
 *  is owned by the drift reconcile) and they polluted the new pending-sync
 *  strip as if current failures. Dry-run by default; --apply executes. */
const prisma = (await import('../src/db.js')).default
const APPLY = process.argv.includes('--apply')
const where = {
  syncStatus: 'FAILED' as const,
  errorMessage: { contains: 'publishing is disabled (gated)' },
  createdAt: { lt: new Date('2026-07-01T00:00:00Z') },
}
const rows = await prisma.outboundSyncQueue.findMany({
  where,
  select: { id: true, syncType: true, targetChannel: true, targetRegion: true, createdAt: true, product: { select: { sku: true } } },
})
console.log(`matched ${rows.length} gated-era FAILED corpses`)
for (const r of rows.slice(0, 8)) console.log(`  ${r.syncType} ${r.targetChannel}/${r.targetRegion} ${r.product?.sku} ${r.createdAt.toISOString().slice(0, 10)}`)
if (rows.length > 8) console.log(`  …+${rows.length - 8} more`)
if (APPLY && rows.length) {
  const res = await prisma.outboundSyncQueue.updateMany({ where, data: { syncStatus: 'CANCELLED', errorCode: 'STALE_GATED_ERA_CANCELLED' } })
  console.log(`CANCELLED ${res.count}`)
} else {
  console.log('dry-run (pass --apply to cancel)')
}
await prisma.$disconnect()
process.exit(0)
