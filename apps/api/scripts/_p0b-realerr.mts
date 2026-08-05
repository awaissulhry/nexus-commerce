const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', outcome: 'failed', attemptedAt: { gte: new Date(Date.now() - 3 * 3600e3) } },
  orderBy: { attemptedAt: 'desc' },
  take: 8,
  select: { sku: true, marketplace: true, errorMessage: true, errorCode: true, attemptedAt: true },
})
for (const r of rows) console.log(`${r.attemptedAt.toISOString().slice(11, 19)} ${r.sku}@${r.marketplace}\n  ${r.errorMessage?.slice(0, 400)}\n`)
await prisma.$disconnect()
process.exit(0)
