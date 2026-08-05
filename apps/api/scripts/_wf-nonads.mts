/** READ-ONLY: the 2,548 FAILED queue rows that are NOT the ads routing bug — what are they? */
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.outboundSyncQueue.findMany({
  where: { syncStatus: 'FAILED', syncType: { in: ['PRICE_UPDATE', 'QUANTITY_UPDATE'] } },
  select: { syncType: true, targetChannel: true, errorCode: true, errorMessage: true, createdAt: true, updatedAt: true, retryCount: true, productId: true, channelListingId: true },
})
console.log(`non-ads FAILED rows: ${rows.length}`)
const by = new Map<string, number>()
for (const r of rows) by.set(`${r.syncType}|${r.targetChannel}|${r.errorCode}`, (by.get(`${r.syncType}|${r.targetChannel}|${r.errorCode}`) ?? 0) + 1)
for (const [k, n] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}×  ${k}`)
const months = new Map<string, number>()
for (const r of rows) { const m = r.createdAt.toISOString().slice(0, 7); months.set(m, (months.get(m) ?? 0) + 1) }
console.log('\nby month created:')
for (const [m, n] of [...months.entries()].sort()) console.log(`  ${m}  ${n}`)
const recent = rows.filter((r) => r.createdAt >= new Date(Date.now() - 7 * 864e5))
console.log(`\ncreated in the last 7 days: ${recent.length}`)
console.log(`distinct products affected: ${new Set(rows.map((r) => r.productId).filter(Boolean)).size}`)
const samples = rows.slice(0, 3)
for (const s of samples) console.log(`  sample: ${s.syncType} ${s.targetChannel} retry=${s.retryCount} "${(s.errorMessage ?? '').replace(/\s+/g,' ').slice(0,120)}"`)
await prisma.$disconnect()
