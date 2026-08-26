import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const runs = await prisma.agentRun.findMany({
  where: { mode: 'preview' }, orderBy: { createdAt: 'desc' }, take: 2,
  select: { id: true, model: true, provider: true, costUSD: true, inputTokens: true, outputTokens: true },
})
console.log('PREVIEW RUNS:', JSON.stringify(runs))
const steps = await prisma.agentStep.findMany({
  where: { agentRunId: runs[0]?.id, type: 'model' },
  select: { name: true, costUSD: true, inputTokens: true, outputTokens: true },
})
console.log('MODEL STEPS:', JSON.stringify(steps))
const recentReal = await prisma.agentRun.findMany({
  where: { mode: { not: 'preview' }, agentKey: 'amazon-negative-miner', ok: true },
  orderBy: { createdAt: 'desc' }, take: 1,
  select: { model: true, costUSD: true, inputTokens: true, outputTokens: true },
})
console.log('LAST REAL RUN:', JSON.stringify(recentReal))
await prisma.$disconnect()
