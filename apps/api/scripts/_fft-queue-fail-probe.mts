const prisma = (await import('../src/db.js')).default
const rows = await prisma.outboundSyncQueue.findMany({
  where: { targetChannel: 'AMAZON', syncStatus: { in: ['FAILED', 'PENDING', 'IN_PROGRESS'] }, syncType: { notIn: ['AD_BID_UPDATE'] } },
  select: { id: true, syncType: true, syncStatus: true, targetRegion: true, retryCount: true, maxRetries: true, errorMessage: true, errorCode: true, createdAt: true, holdUntil: true, product: { select: { sku: true } } },
  orderBy: { createdAt: 'desc' },
  take: 45,
})
for (const r of rows) {
  console.log(`${r.syncStatus} ${r.syncType} ${r.targetRegion} ${r.product?.sku ?? '-'} retry=${r.retryCount}/${r.maxRetries} created=${r.createdAt.toISOString().slice(5, 16)} hold=${r.holdUntil?.toISOString().slice(11, 16) ?? '-'} code=${r.errorCode ?? '-'} err=${String(r.errorMessage ?? '').slice(0, 140)}`)
}
console.log('total shown:', rows.length)
await prisma.$disconnect()
process.exit(0)
