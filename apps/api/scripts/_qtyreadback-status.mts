/** READ-ONLY: how the Amazon qty read-back loop is actually behaving on prod. */
const { default: prisma } = await import('../src/db.js')

const runs = await prisma.cronRun.findMany({
  where: { jobName: { in: ['amazon-qty-readback', 'amazon-qty-readback-request'] } },
  orderBy: { startedAt: 'desc' },
  take: 10,
  select: { jobName: true, startedAt: true, finishedAt: true, status: true, outputSummary: true },
})
console.log('--- recent amazon-qty-readback runs (UTC) ---')
for (const r of runs) {
  const dur = r.finishedAt ? ((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(0) + 's' : '—'
  console.log(`${r.startedAt.toISOString()}  ${r.status.padEnd(8)} ${dur.padStart(5)}  ${String(r.outputSummary ?? '').slice(0, 220)}`)
}
console.log('\nnow (UTC):', new Date().toISOString())

const open = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED', channel: 'AMAZON' },
  orderBy: { createdAt: 'desc' },
  take: 8,
  select: { createdAt: true, errorMessage: true, conflictData: true },
})
console.log('\n--- newest open AMAZON readback drift rows ---')
for (const o of open) console.log(`${o.createdAt.toISOString()}  ${String(o.errorMessage ?? JSON.stringify(o.conflictData)).slice(0, 150)}`)

// How long from heal-row creation to actual delivery?
const heals = await prisma.outboundSyncQueue.findMany({
  where: { createdAt: { gte: new Date(Date.now() - 14 * 24 * 3600e3) }, syncType: 'QUANTITY_UPDATE', targetChannel: 'AMAZON' },
  select: { createdAt: true, updatedAt: true, syncStatus: true, payload: true, targetRegion: true },
  orderBy: { createdAt: 'desc' },
  take: 6000,
})
const healRows = heals.filter((h) => (h.payload as { source?: string } | null)?.source === 'QTY_READBACK_HEAL')
const lags = healRows
  .filter((h) => h.syncStatus === 'SUCCESS')
  .map((h) => (h.updatedAt.getTime() - h.createdAt.getTime()) / 1000)
  .sort((a, b) => a - b)
console.log(`\nQTY_READBACK_HEAL rows last 14d: ${healRows.length}; SUCCESS ${lags.length}`)
if (lags.length) {
  const p = (q: number) => lags[Math.min(lags.length - 1, Math.floor(lags.length * q))].toFixed(0) + 's'
  console.log(`  create→delivered lag: p50 ${p(0.5)}  p90 ${p(0.9)}  max ${lags[lags.length - 1].toFixed(0)}s`)
}
await prisma.$disconnect()
