// NAF.A acceptance verification (read-only). Run: railway run npx tsx apps/api/scripts/_nafa-verify.mts
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const charters = await prisma.agentCharter.findMany({
  select: { id: true, key: true, version: true, enabled: true, autonomyLevel: true, autonomyCap: true },
})
console.log('AgentCharter rows:', JSON.stringify(charters, null, 2))

const state = await prisma.agentFleetState.findMany()
console.log('AgentFleetState:', JSON.stringify(state, null, 2))

const runs = await prisma.agentRun.findMany({
  where: { agentKey: 'fleet-selftest' },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: {
    id: true, agentKey: true, charterVersion: true, mode: true, trigger: true,
    status: true, ok: true, findingCount: true, inputTokens: true, outputTokens: true,
    costUSD: true, model: true, provider: true, latencyMs: true, haltedReason: true,
    errorMessage: true, createdAt: true, endedAt: true, output: true,
  },
})
console.log('fleet-selftest runs:', JSON.stringify(runs, null, 2))

for (const run of runs) {
  const steps = await prisma.agentStep.findMany({
    where: { agentRunId: run.id },
    orderBy: { seq: 'asc' },
    select: {
      seq: true, type: true, name: true, inputTokens: true, outputTokens: true,
      costUSD: true, latencyMs: true, ok: true, errorMessage: true, output: true,
    },
  })
  console.log(`AgentStep trace for ${run.id}:`, JSON.stringify(steps, null, 2))
}

const findings = await prisma.agentFinding.findMany({
  where: { charterKey: 'fleet-selftest' },
  orderBy: { createdAt: 'desc' },
  select: {
    id: true, runId: true, charterVersion: true, domain: true, entityType: true,
    entityId: true, kind: true, severity: true, confidence: true, evidenceRefs: true,
    dataVintage: true, rationale: true, dedupeKey: true, status: true, expiresAt: true,
  },
})
console.log('AgentFinding rows:', JSON.stringify(findings, null, 2))

const obs = await prisma.agentObservation.findMany({
  select: { id: true, key: true, computedAt: true, expiresAt: true, dataVintage: true },
})
console.log('AgentObservation rows:', JSON.stringify(obs, null, 2))

// Evidence integrity: every finding ref must point at a real observation row.
const obsIds = new Set(obs.map((o) => o.id))
for (const f of findings) {
  const bad = f.evidenceRefs.filter((r) => !obsIds.has(r))
  console.log(`finding ${f.id}: evidenceRefs ${bad.length === 0 ? 'ALL RESOLVE ✓' : `BROKEN: ${bad.join(',')}`}`)
}

const usage = await prisma.aiUsageLog.findMany({
  where: { feature: 'agent-fleet-analyst' },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { provider: true, model: true, inputTokens: true, outputTokens: true, costUSD: true, ok: true, createdAt: true },
})
console.log('AiUsageLog (agent-fleet-analyst):', JSON.stringify(usage, null, 2))

await prisma.$disconnect()
