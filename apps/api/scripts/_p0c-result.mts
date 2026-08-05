const { default: prisma } = await import('../src/db.js')
for (const j of ['amazon-qty-readback', 'amazon-qty-readback-request']) {
  const r = await prisma.cronRun.findFirst({ where: { jobName: j }, orderBy: { startedAt: 'desc' } })
  console.log(`${j}: ${r ? `${r.status} @${r.startedAt.toISOString().slice(11, 19)} — ${(r.outputSummary ?? '').slice(0, 400)} ${r.errorMessage ? 'ERR=' + r.errorMessage.slice(0, 150) : ''}` : 'NOT YET'}`)
}
const mismatch = await prisma.syncHealthLog.count({ where: { conflictType: 'CHANNEL_QTY_READBACK', createdAt: { gte: new Date(Date.now() - 3600e3) } } })
console.log(`CHANNEL_QTY_READBACK rows last hour: ${mismatch}`)
await prisma.$disconnect()
process.exit(0)
