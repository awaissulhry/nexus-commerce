// NAF.SB.ACT — read-only close-out: is every claim the page makes still true?
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { countFleetTimeline } = await import(
  '../src/services/agent-fleet/fleet-timeline.service.js'
)

const all = await countFleetTimeline({})
const noDiag = await countFleetTimeline({ includeDiagnostic: false })
console.log('events (self-test in / out) =', all.total, '/', noDiag.total)
console.log('countsByKind (out)          =', JSON.stringify(noDiag.countsByKind))

console.log('\n=== Q4 · test runs in the headline count ===')
const runs = await prisma.agentRun.findMany({
  where: { mode: { not: null } },
  select: { agentKey: true, mode: true },
})
const biz = runs.filter((r) => r.agentKey !== 'fleet-selftest')
const preview = biz.filter((r) => r.mode === 'preview').length
console.log(`business runs = ${biz.length}, of which test runs = ${preview}`)
console.log('  → the scope line counts them; only the badge distinguishes them.')

console.log('\n=== S6 footnote claim: "decisions before the fleet existed" ===')
const approvals = await prisma.agentApproval.findMany({
  select: { id: true, agentRunId: true, status: true, decidedBy: true, decidedAt: true, requestedAt: true },
})
const fleetRunIds = new Set(
  (await prisma.agentRun.findMany({ where: { mode: { not: null } }, select: { id: true } })).map((r) => r.id),
)
const fleetApprovals = approvals.filter((a) => fleetRunIds.has(a.agentRunId))
console.log('approvals total          =', approvals.length)
console.log('attached to a FLEET run  =', fleetApprovals.length, '(was 0 when the page was designed)')
console.log('  fleet approvals decided =', fleetApprovals.filter((a) => a.decidedAt).length)
console.log('  fleet approvals pending =', fleetApprovals.filter((a) => a.status === 'pending').length)

console.log('\n=== is a run in flight right now? (the run.running path) ===')
const running = await prisma.agentRun.count({ where: { mode: { not: null }, status: 'running' } })
console.log('running fleet runs =', running, running === 0 ? '(run.running still unexercised on real data)' : '')

console.log('\n=== deferred-section triggers ===')
const audit = await prisma.agentControlAudit.count()
console.log('AgentControlAudit rows =', audit, audit === 0 ? '→ S8 still correctly deferred' : '→ S8 TRIGGER FIRED')
const perWorker = new Map<string, number>()
for (const r of runs) perWorker.set(r.agentKey, (perWorker.get(r.agentKey) ?? 0) + 1)
const top = [...perWorker.entries()].sort((a, b) => b[1] - a[1])[0]
console.log('busiest worker =', top?.[0], top?.[1], 'runs', (top?.[1] ?? 0) >= 10 ? '→ S9 worth revisiting' : '→ S9 still deferred')

await prisma.$disconnect()
