// NAF.DTL probe 2 — the detail behind each panel: sweep grouping, cost,
// approval history, run failures, and whether 'fleet-auditor' exists at all.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const runs = await prisma.agentRun.findMany({
  where: { mode: { not: null } },
  select: {
    id: true, agentKey: true, mode: true, trigger: true, status: true, ok: true,
    findingCount: true, costUSD: true, latencyMs: true, errorMessage: true,
    orchestrationId: true, createdAt: true,
  },
  orderBy: { createdAt: 'desc' },
})
console.log('— fleet runs —', runs.length)
const byMode = new Map<string, number>()
for (const r of runs) byMode.set(r.mode ?? '?', (byMode.get(r.mode ?? '?') ?? 0) + 1)
console.log('  by mode:', JSON.stringify([...byMode]))
const orch = new Set(runs.map((r) => r.orchestrationId).filter(Boolean))
console.log('  distinct orchestrationIds:', orch.size)
const totalCost = runs.reduce((s, r) => s + Number(r.costUSD), 0)
console.log('  total cost USD:', totalCost.toFixed(6))
console.log('  failures:')
const errs = new Map<string, number>()
for (const r of runs.filter((x) => !x.ok)) {
  const k = (r.errorMessage ?? 'no message').slice(0, 90)
  errs.set(k, (errs.get(k) ?? 0) + 1)
}
for (const [k, n] of errs) console.log(`    ${n}x ${k}`)

const approvals = await prisma.agentApproval.findMany({
  select: {
    id: true, toolName: true, status: true, decidedBy: true, decidedAt: true,
    reason: true, riskTier: true, requestedAt: true, agentRunId: true,
  },
  orderBy: { requestedAt: 'desc' },
  take: 20,
})
console.log('— approvals (recent) —')
for (const a of approvals)
  console.log(`  ${a.requestedAt.toISOString().slice(0, 16)} ${a.status.padEnd(9)} ${a.toolName} by=${a.decidedBy ?? "—"} at=${a.decidedAt?.toISOString().slice(0,16) ?? "—"} risk=${a.riskTier} reason=${(a.reason ?? "—").slice(0, 40)}`)

const auditor = await prisma.agentCharter.findFirst({ where: { key: 'fleet-auditor' } })
console.log('— fleet-auditor charter row —', auditor ? 'EXISTS' : 'MISSING')

const kinds = await prisma.agentFinding.groupBy({ by: ['charterKey', 'kind'], _count: true })
console.log('— findings by charter/kind —', JSON.stringify(kinds))

const plan = await prisma.agentPlan.findFirst({ orderBy: { createdAt: 'desc' } })
console.log('— the one plan —')
console.log('  status', plan?.status, 'verdict', plan?.criticVerdict)
console.log('  headline', plan?.headline)
console.log('  items', Array.isArray(plan?.items) ? (plan?.items as unknown[]).length : '?')
console.log('  approvalIds', JSON.stringify(plan?.approvalIds))

await prisma.$disconnect()
