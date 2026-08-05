/** READ-ONLY: did the FOLLOW pushes from the prod verification dispatch? */
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 12 * 60 * 1000)
const rows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', createdAt: { gte: since } },
  select: { syncStatus: true, targetChannel: true, payload: true, errorMessage: true },
})
const by = new Map<string, number>()
for (const r of rows) {
  const src = (r.payload as any)?.source ?? '?'
  by.set(`${src}|${r.targetChannel}|${r.syncStatus}`, (by.get(`${src}|${r.targetChannel}|${r.syncStatus}`) ?? 0) + 1)
}
console.log(`QUANTITY_UPDATE rows created in last 12min: ${rows.length}`)
for (const [k, n] of [...by.entries()].sort()) console.log(`  ${k.padEnd(44)} ${n}`)
const failed = rows.filter((r) => r.syncStatus === 'FAILED')
for (const f of failed.slice(0, 5)) console.log(`  FAILED: ${f.errorMessage?.slice(0, 120)}`)
await prisma.$disconnect()
