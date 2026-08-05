const { default: prisma } = await import('../src/db.js')
const rows = await prisma.outboundSyncQueue.groupBy({
  by: ['errorCode'],
  where: { syncType: 'QUANTITY_UPDATE', targetChannel: 'EBAY', syncStatus: 'FAILED', createdAt: { gte: new Date(Date.now() - 30 * 60e3) } },
  _count: { _all: true },
})
console.log(JSON.stringify(rows.map((r) => `${r.errorCode}=${r._count._all}`)))
await prisma.$disconnect()
process.exit(0)
