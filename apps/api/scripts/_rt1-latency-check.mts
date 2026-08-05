/** READ-ONLY: RT.1 verify — latency of queue rows created in the last N hours (default 3). */
const { default: prisma } = await import('../src/db.js')
const hours = Number(process.argv[2] ?? 3)
const since = new Date(Date.now() - hours * 3600e3)

const rows = await prisma.outboundSyncQueue.findMany({
  where: { createdAt: { gte: since }, syncType: { in: ['QUANTITY_UPDATE', 'PRICE_UPDATE'] } },
  select: {
    targetChannel: true, syncType: true, syncStatus: true,
    createdAt: true, syncedAt: true, holdUntil: true, payload: true,
  },
  orderBy: { createdAt: 'desc' },
})
console.log(`rows last ${hours}h: ${rows.length}`)
const secs = (ms: number) => Math.round(ms / 100) / 10
for (const r of rows.slice(0, 25)) {
  const src = (r.payload as { source?: string } | null)?.source ?? '?'
  const hold = r.holdUntil ? secs(r.holdUntil.getTime() - r.createdAt.getTime()) : 0
  const lat = r.syncedAt ? secs(r.syncedAt.getTime() - r.createdAt.getTime()) : null
  const postHold = r.syncedAt && r.holdUntil ? secs(r.syncedAt.getTime() - r.holdUntil.getTime()) : null
  console.log(`  ${r.createdAt.toISOString().slice(11, 19)} ${r.targetChannel}:${r.syncType} ${r.syncStatus} src=${src} hold=${hold}s latency=${lat ?? '-'}s afterHold=${postHold ?? '-'}s`)
}
const synced = rows.filter((r) => r.syncedAt)
if (synced.length) {
  const lats = synced.map((r) => r.syncedAt!.getTime() - r.createdAt.getTime()).sort((a, b) => a - b)
  const p = (q: number) => secs(lats[Math.min(lats.length - 1, Math.floor((q / 100) * lats.length))])
  console.log(`latency: n=${synced.length} min=${secs(lats[0])}s p50=${p(50)}s p90=${p(90)}s max=${secs(lats[lats.length - 1])}s`)
  const afterHold = synced
    .filter((r) => r.holdUntil)
    .map((r) => r.syncedAt!.getTime() - r.holdUntil!.getTime())
    .sort((a, b) => a - b)
  if (afterHold.length) {
    const ph = (q: number) => secs(afterHold[Math.min(afterHold.length - 1, Math.floor((q / 100) * afterHold.length))])
    console.log(`after-hold dispatch delay: n=${afterHold.length} min=${secs(afterHold[0])}s p50=${ph(50)}s p90=${ph(90)}s`)
  }
}
await prisma.$disconnect()
process.exit(0)
