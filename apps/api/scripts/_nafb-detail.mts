import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const step = await prisma.agentStep.findFirst({
  where: { agentRunId: 'cmshhbpj4006qt701w4q1cr1f', type: 'validation' },
  select: { errorMessage: true },
})
console.log('MINER VALIDATION ERROR:', step?.errorMessage)
const tuner = await prisma.agentRun.findUnique({
  where: { id: 'cmshhctmx00cet701d5foimwt' },
  select: { status: true, ok: true, findingCount: true, costUSD: true, latencyMs: true, errorMessage: true, endedAt: true },
})
console.log('TUNER NOW:', JSON.stringify(tuner))
const tunerSteps = await prisma.agentStep.findMany({
  where: { agentRunId: 'cmshhctmx00cet701d5foimwt' },
  orderBy: { seq: 'asc' },
  select: { seq: true, type: true, name: true, ok: true, latencyMs: true },
})
console.log('TUNER STEPS:', JSON.stringify(tunerSteps))
await prisma.$disconnect()
