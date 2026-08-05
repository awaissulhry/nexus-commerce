/** READ-ONLY: did the pilot ZERO_PIN push dispatch? */
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', createdAt: { gte: new Date(Date.now() - 10 * 60e3) }, product: { sku: 'REGAL-JACKET-3XL-GREY-MEN' } },
  select: { syncStatus: true, targetRegion: true, errorMessage: true, payload: true, updatedAt: true },
})
for (const r of rows) console.log(`${r.targetRegion} ${r.syncStatus} qty=${(r.payload as any)?.quantity} src=${(r.payload as any)?.source} err=${r.errorMessage?.slice(0,80) ?? '-'}`)
if (!rows.length) console.log('no queue rows found')
await prisma.$disconnect()
