// NAF.B supervised-run verification (read-only). Args: run ids.
// railway run npx tsx apps/api/scripts/_nafb-verify.mts <runId> [<runId>...]
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const runIds = process.argv.slice(2)

for (const runId of runIds) {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { id: true, agentKey: true, status: true, ok: true, findingCount: true, inputTokens: true, outputTokens: true, costUSD: true, model: true, latencyMs: true, haltedReason: true, errorMessage: true },
  })
  console.log('RUN:', JSON.stringify(run))
  const steps = await prisma.agentStep.findMany({
    where: { agentRunId: runId }, orderBy: { seq: 'asc' },
    select: { seq: true, type: true, name: true, ok: true, latencyMs: true, errorMessage: true },
  })
  console.log('STEPS:', steps.map((s) => `${s.seq}:${s.type}:${s.name}:${s.ok ? 'ok' : 'FAIL'}`).join(' | '))
  const findings = await prisma.agentFinding.findMany({
    where: { runId },
    select: { id: true, kind: true, entityType: true, entityId: true, severity: true, confidence: true, dedupeKey: true, evidenceRefs: true },
  })
  for (const f of findings) {
    const grammarOk = new RegExp('^[a-z_]{3,40}:.+$').test(f.dedupeKey) && f.dedupeKey === `${f.kind}:${f.entityId}`
    const grade = await prisma.agentShadowGrade.findUnique({ where: { findingId: f.id }, select: { agrees: true, disagreementReason: true, engineKey: true } })
    console.log(`  FINDING ${f.kind} ${f.entityId} sev=${f.severity} conf=${f.confidence} key="${f.dedupeKey}" grammar=${grammarOk ? 'EXACT' : 'pattern-only'} grade=${grade ? (grade.agrees ? 'AGREES' : `disagrees(${grade.disagreementReason})`) : 'UNGRADED'}`)
  }
  console.log('---')
}
const obs = await prisma.agentObservation.findMany({ select: { id: true, key: true, dataVintage: true, expiresAt: true } })
console.log('OBSERVATIONS:', JSON.stringify(obs.map((o) => ({ id: o.id, key: o.key, vintage: o.dataVintage })), null, 2))
await prisma.$disconnect()
