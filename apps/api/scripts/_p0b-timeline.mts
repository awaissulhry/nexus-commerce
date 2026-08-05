const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', outcome: { in: ['success', 'failed'] }, attemptedAt: { gte: new Date(Date.now() - 40 * 60e3) } },
  orderBy: { attemptedAt: 'asc' },
  select: { attemptedAt: true, outcome: true, sku: true, errorMessage: true },
})
for (const r of rows) console.log(`${r.attemptedAt.toISOString().slice(11, 19)} ${r.outcome.padEnd(7)} ${r.sku} ${r.errorMessage ? '— ' + r.errorMessage.slice(0, 60) : ''}`)
await prisma.$disconnect()
process.exit(0)
