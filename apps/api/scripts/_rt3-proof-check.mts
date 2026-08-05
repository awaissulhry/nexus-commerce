/** READ-ONLY: pipe-proof status — recent sqs-poll summaries + canary movements. */
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'amazon-sqs-poll', startedAt: { gte: new Date(Date.now() - 15 * 60e3) } },
  orderBy: { startedAt: 'desc' },
  take: 14,
  select: { startedAt: true, outputSummary: true },
})
for (const r of runs) console.log(r.startedAt.toISOString().slice(11, 19), r.outputSummary ?? '')
const mv = await prisma.stockMovement.findMany({
  where: { notes: { contains: 'RT.3 pipe proof' } },
  select: { change: true, balanceAfter: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
})
console.log('canary movements:', JSON.stringify(mv.map((m) => ({ c: m.change, b: m.balanceAfter, t: m.createdAt.toISOString().slice(11, 19) }))))
const we = await prisma.webhookEvent.count({
  where: { channel: 'AMAZON', createdAt: { gte: new Date(Date.now() - 20 * 60e3) } },
}).catch(() => -1)
console.log('WebhookEvent AMAZON rows last 20min:', we)
await prisma.$disconnect()
process.exit(0)
