import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.agentRun.updateMany({
  where: { id: 'cmshhctmx00cet701d5foimwt', status: 'running' },
  data: { status: 'failed', ok: false, errorMessage: 'orphaned: builder hang (computeFleetTargetAcos unbounded loop) — process restarted by fix deploy cdfa2fb3e', endedAt: new Date() },
})
console.log('orphan closed:', r.count)
await prisma.$disconnect()
