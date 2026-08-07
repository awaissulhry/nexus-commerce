// NAF.SB.ACT.5 — read-only: does AgentFinding.runId ever name a fleet run?
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const findings = await prisma.agentFinding.findMany({
  select: { id: true, runId: true, charterKey: true, createdAt: true },
})
const runs = await prisma.agentRun.findMany({
  where: { mode: { not: null } },
  select: { id: true, agentKey: true, findingCount: true, createdAt: true },
})
const runIds = new Set(runs.map((r) => r.id))

const matched = findings.filter((f) => runIds.has(f.runId))
console.log('findings total          =', findings.length)
console.log('findings whose runId is a FLEET run =', matched.length)
console.log('distinct runIds on findings         =', new Set(findings.map((f) => f.runId)).size)

const allRunIds = new Set((await prisma.agentRun.findMany({ select: { id: true } })).map((r) => r.id))
console.log('findings whose runId is ANY AgentRun =', findings.filter((f) => allRunIds.has(f.runId)).length)

console.log('\nruns claiming findings but owning none:')
let claiming = 0
let owningNone = 0
for (const r of runs) {
  if (r.findingCount <= 0) continue
  claiming++
  const owned = findings.filter((f) => f.runId === r.id).length
  if (owned === 0) owningNone++
}
console.log(`  ${owningNone} of ${claiming} runs with findingCount > 0 own zero AgentFinding rows`)

console.log('\nsample finding runIds vs a sample run id:')
console.log('  finding.runId sample =', findings.slice(0, 3).map((f) => f.runId))
console.log('  fleet run id sample  =', runs.slice(0, 3).map((r) => r.id))

await prisma.$disconnect()
