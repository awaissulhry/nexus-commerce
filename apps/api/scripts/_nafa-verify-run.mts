// Focused acceptance evidence for one run id (arg 1). Read-only.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const runId = process.argv[2]!
const steps = await prisma.agentStep.findMany({
  where: { agentRunId: runId },
  orderBy: { seq: 'asc' },
  select: { seq: true, type: true, name: true, inputTokens: true, outputTokens: true, costUSD: true, latencyMs: true, ok: true, errorMessage: true, output: true },
})
console.log('STEPS:', JSON.stringify(steps, null, 2))
const findings = await prisma.agentFinding.findMany({
  where: { runId },
  select: { id: true, entityId: true, kind: true, severity: true, dedupeKey: true, evidenceRefs: true, dataVintage: true, expiresAt: true },
})
const obs = await prisma.agentObservation.findMany({ select: { id: true, key: true, computedAt: true, expiresAt: true } })
const obsIds = new Set(obs.map((o) => o.id))
for (const f of findings) {
  const bad = f.evidenceRefs.filter((r) => !obsIds.has(r))
  console.log(`FINDING ${f.entityId} [${f.kind}/${f.severity}] refs ${bad.length === 0 ? 'RESOLVE ✓' : 'BROKEN: ' + bad.join(',')}`)
}
console.log('OBSERVATIONS:', JSON.stringify(obs, null, 2))
const usage = await prisma.aiUsageLog.findMany({
  where: { feature: 'agent-fleet-analyst', ok: true },
  orderBy: { createdAt: 'desc' }, take: 3,
  select: { provider: true, model: true, inputTokens: true, outputTokens: true, costUSD: true, createdAt: true },
})
console.log('USAGE:', JSON.stringify(usage, null, 2))
await prisma.$disconnect()
