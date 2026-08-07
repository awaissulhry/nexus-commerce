// NAF.SB.A — read-only truth probe for /fleet/activity. SELECT/count only.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const log = (...a: unknown[]) => console.log(...a)
async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (e: any) {
    log(`!! ${label} THREW: ${e?.code ?? ''} ${e?.message ?? String(e)}`)
    return null
  }
}

const FLEET = { mode: { not: null } } as const
const now = Date.now()
const ago = (d: number) => new Date(now - d * 86400_000)

log('===== AgentRun (fleet: mode not null) =====')
await safe('total', async () => log('total fleet runs =', await prisma.agentRun.count({ where: FLEET })))
await safe('all runs total', async () => log('ALL AgentRun rows (incl. mode null) =', await prisma.agentRun.count()))
await safe('by mode', async () =>
  log('by mode:', JSON.stringify(await prisma.agentRun.groupBy({ by: ['mode'], _count: true, where: FLEET }))),
)
await safe('by status', async () =>
  log('by status:', JSON.stringify(await prisma.agentRun.groupBy({ by: ['status'], _count: true, where: FLEET }))),
)
await safe('by ok', async () =>
  log('by ok:', JSON.stringify(await prisma.agentRun.groupBy({ by: ['ok'], _count: true, where: FLEET }))),
)
await safe('by agentKey', async () =>
  log(
    'by agentKey:',
    JSON.stringify(await prisma.agentRun.groupBy({ by: ['agentKey'], _count: true, where: FLEET, orderBy: { agentKey: 'asc' } })),
  ),
)
await safe('by trigger', async () =>
  log('by trigger:', JSON.stringify(await prisma.agentRun.groupBy({ by: ['trigger'], _count: true, where: FLEET }))),
)
await safe('by model', async () =>
  log('by model:', JSON.stringify(await prisma.agentRun.groupBy({ by: ['model'], _count: true, where: FLEET }))),
)

log('\n===== recency =====')
for (const [label, d] of [['24h', 1], ['7d', 7], ['30d', 30]] as const) {
  await safe(`window ${label}`, async () =>
    log(`fleet runs last ${label} =`, await prisma.agentRun.count({ where: { ...FLEET, createdAt: { gte: ago(d) } } })),
  )
}
await safe('oldest/newest', async () => {
  const oldest = await prisma.agentRun.findFirst({ where: FLEET, orderBy: { createdAt: 'asc' }, select: { createdAt: true, agentKey: true, mode: true } })
  const newest = await prisma.agentRun.findFirst({ where: FLEET, orderBy: { createdAt: 'desc' }, select: { createdAt: true, agentKey: true, mode: true } })
  log('oldest:', oldest?.createdAt.toISOString(), oldest?.agentKey, oldest?.mode)
  log('newest:', newest?.createdAt.toISOString(), newest?.agentKey, newest?.mode)
})
// distinct calendar days with at least one run
await safe('days with runs', async () => {
  const rows = await prisma.agentRun.findMany({ where: FLEET, select: { createdAt: true } })
  const days = new Set(rows.map((r) => r.createdAt.toISOString().slice(0, 10)))
  log('distinct UTC days with >=1 fleet run =', days.size, JSON.stringify([...days].sort()))
})

log('\n===== failure taxonomy =====')
await safe('errorMessage', async () => {
  const g = await prisma.agentRun.groupBy({ by: ['errorMessage'], _count: true, where: FLEET })
  for (const r of g) log(`  ${r._count} × ${r.errorMessage === null ? '(null)' : JSON.stringify(r.errorMessage)}`)
})
await safe('haltedReason', async () => {
  const g = await prisma.agentRun.groupBy({ by: ['haltedReason'], _count: true, where: FLEET })
  for (const r of g) log(`  ${r._count} × halted=${r.haltedReason === null ? '(null)' : JSON.stringify(r.haltedReason)}`)
})

log('\n===== cost / tokens / latency =====')
await safe('economics', async () => {
  const rows = await prisma.agentRun.findMany({
    where: FLEET,
    select: { costUSD: true, inputTokens: true, outputTokens: true, latencyMs: true },
  })
  const costs = rows.map((r) => Number(r.costUSD))
  const withLat = rows.filter((r) => r.latencyMs != null).length
  const withCost = costs.filter((c) => c > 0).length
  const withTok = rows.filter((r) => r.inputTokens + r.outputTokens > 0).length
  const sorted = [...costs].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0
  const lats = rows.filter((r) => r.latencyMs != null).map((r) => r.latencyMs as number).sort((a, b) => a - b)
  log('rows =', rows.length, '| latencyMs non-null =', withLat, '| costUSD>0 =', withCost, '| tokens>0 =', withTok)
  log('total costUSD =', costs.reduce((a, b) => a + b, 0).toFixed(6), '| median cost/run =', median.toFixed(6), '| max =', (sorted.at(-1) ?? 0).toFixed(6))
  log('total inputTokens =', rows.reduce((a, r) => a + r.inputTokens, 0), '| outputTokens =', rows.reduce((a, r) => a + r.outputTokens, 0))
  log('latency ms: min =', lats[0], 'median =', lats[Math.floor((lats.length - 1) / 2)], 'max =', lats.at(-1))
})

log('\n===== AgentStep =====')
await safe('steps', async () => {
  log('AgentStep total rows =', await prisma.agentStep.count())
  const g = await prisma.agentStep.groupBy({ by: ['agentRunId'], _count: true })
  const counts = g.map((r) => r._count).sort((a, b) => a - b)
  log('runs with >=1 step =', g.length)
  if (counts.length) log('steps/run: min =', counts[0], 'median =', counts[Math.floor((counts.length - 1) / 2)], 'max =', counts.at(-1))
  const fleetRuns = await prisma.agentRun.count({ where: FLEET })
  log('fleet runs with ZERO steps =', fleetRuns - g.length, '(approx: step-owning runs may include non-fleet)')
  log('steps by type:', JSON.stringify(await prisma.agentStep.groupBy({ by: ['type'], _count: true })))
  log('steps by ok:', JSON.stringify(await prisma.agentStep.groupBy({ by: ['ok'], _count: true })))
})

log('\n===== AgentFinding =====')
await safe('findings', async () => {
  log('total =', await prisma.agentFinding.count())
  log('by kind:', JSON.stringify(await prisma.agentFinding.groupBy({ by: ['kind'], _count: true })))
  log('by status:', JSON.stringify(await prisma.agentFinding.groupBy({ by: ['status'], _count: true })))
  log('by severity:', JSON.stringify(await prisma.agentFinding.groupBy({ by: ['severity'], _count: true })))
  log('by charterKey:', JSON.stringify(await prisma.agentFinding.groupBy({ by: ['charterKey'], _count: true })))
})

log('\n===== AgentPlan =====')
await safe('plans', async () => {
  log('total =', await prisma.agentPlan.count())
  log('by status:', JSON.stringify(await prisma.agentPlan.groupBy({ by: ['status'], _count: true })))
  log('by criticVerdict:', JSON.stringify(await prisma.agentPlan.groupBy({ by: ['criticVerdict'], _count: true })))
})

log('\n===== AgentApproval =====')
await safe('approvals', async () => {
  log('total =', await prisma.agentApproval.count())
  log('by status:', JSON.stringify(await prisma.agentApproval.groupBy({ by: ['status'], _count: true })))
  log('by riskTier:', JSON.stringify(await prisma.agentApproval.groupBy({ by: ['riskTier'], _count: true })))
  log('decidedBy non-null =', await prisma.agentApproval.count({ where: { decidedBy: { not: null } } }))
  log('by toolName:', JSON.stringify(await prisma.agentApproval.groupBy({ by: ['toolName'], _count: true })))
})

log('\n===== AgentControlAudit =====')
await safe('control audit count', async () => log('AgentControlAudit rows =', await prisma.agentControlAudit.count()))
await safe('control audit raw table probe', async () => {
  const r: any[] = await prisma.$queryRawUnsafe(`select to_regclass('"AgentControlAudit"') as t`)
  log('to_regclass("AgentControlAudit") =', JSON.stringify(r))
})
await safe('control audit by action', async () =>
  log('by action:', JSON.stringify(await prisma.agentControlAudit.groupBy({ by: ['action'], _count: true }))),
)

log('\n===== workflowKey =====')
await safe('workflowKey', async () => {
  log('fleet runs with workflowKey non-null =', await prisma.agentRun.count({ where: { ...FLEET, workflowKey: { not: null } } }))
  log('by workflowKey:', JSON.stringify(await prisma.agentRun.groupBy({ by: ['workflowKey'], _count: true, where: FLEET })))
  log('AgentWorkflow rows =', await prisma.agentWorkflow.count())
})

log('\n===== adjacent tables =====')
for (const [name, fn] of [
  ['AgentCharter', () => prisma.agentCharter.count()],
  ['AgentScorecard', () => prisma.agentScorecard.count()],
  ['AgentObservation', () => prisma.agentObservation.count()],
  ['AgentStrategy', () => prisma.agentStrategy.count()],
  ['AgentExemplar', () => prisma.agentExemplar.count()],
  ['AgentShadowGrade', () => prisma.agentShadowGrade.count()],
  ['AgentEvalRun', () => prisma.agentEvalRun.count()],
  ['AgentFleetState', () => prisma.agentFleetState.count()],
  ['AgentCharterRevision', () => prisma.agentCharterRevision.count()],
  ['AgentWorkflowRevision', () => prisma.agentWorkflowRevision.count()],
  ['AgentMemory', () => prisma.agentMemory.count()],
] as const) {
  await safe(name, async () => log(`${name} =`, await fn()))
}

log('\n===== countFleetTimeline() =====')
await safe('timeline spine', async () => {
  const { countFleetTimeline } = await import('../src/services/agent-fleet/fleet-timeline.service.js')
  const t = await countFleetTimeline({})
  log('total =', t.total)
  log('countsByKind =', JSON.stringify(t.countsByKind))
  log('actors =', JSON.stringify(t.actors))
})

log('\n===== PART 2: provenance =====')
await safe('approvals provenance', async () => {
  const aps = await prisma.agentApproval.findMany({
    select: { id: true, requestedAt: true, decidedAt: true, status: true, agentRun: { select: { mode: true, agentKey: true } } },
    orderBy: { requestedAt: 'asc' },
  })
  const fleetLinked = aps.filter((a) => a.agentRun?.mode != null).length
  log('approvals total =', aps.length, '| attached to a FLEET run (mode not null) =', fleetLinked)
  log('approval requestedAt range:', aps[0]?.requestedAt.toISOString(), '→', aps.at(-1)?.requestedAt.toISOString())
  log('approvals with decidedAt non-null =', aps.filter((a) => a.decidedAt != null).length)
  log('owning run agentKeys:', JSON.stringify([...new Set(aps.map((a) => a.agentRun?.agentKey ?? '(none)'))]))
})
await safe('non-fleet runs', async () => {
  const g = await prisma.agentRun.groupBy({ by: ['agentKey'], _count: true, where: { mode: null } })
  log('mode=null runs by agentKey:', JSON.stringify(g))
  const oldest = await prisma.agentRun.findFirst({ where: { mode: null }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  const newest = await prisma.agentRun.findFirst({ where: { mode: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
  log('mode=null range:', oldest?.createdAt.toISOString(), '→', newest?.createdAt.toISOString())
})
await safe('episodes', async () => {
  const g = await prisma.agentRun.groupBy({ by: ['orchestrationId'], _count: true, where: FLEET })
  log('orchestrationId groups:', JSON.stringify(g))
})
await safe('control audit table exists', async () => {
  const r: any[] = await prisma.$queryRawUnsafe(
    `select table_name::text as t from information_schema.tables where table_schema='public' and table_name='AgentControlAudit'`,
  )
  log('information_schema hit for AgentControlAudit:', JSON.stringify(r))
})
await safe('findings per run', async () => {
  const g = await prisma.agentFinding.groupBy({ by: ['runId'], _count: true })
  const c = g.map((r) => r._count).sort((a, b) => a - b)
  log('runs that produced findings =', g.length, '| findings/run min/median/max =', c[0], c[Math.floor((c.length - 1) / 2)], c.at(-1))
})
await safe('finding created range', async () => {
  const o = await prisma.agentFinding.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  const n = await prisma.agentFinding.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
  log('findings range:', o?.createdAt.toISOString(), '→', n?.createdAt.toISOString())
})
await safe('fleet state halt', async () => {
  log('AgentFleetState:', JSON.stringify(await prisma.agentFleetState.findMany()))
})

await safe('paid runs', async () => {
  const rows = await prisma.agentRun.findMany({ where: FLEET, select: { costUSD: true, mode: true, model: true } })
  const paid = rows.map((r) => Number(r.costUSD)).filter((c) => c > 0).sort((a, b) => a - b)
  log('paid runs =', paid.length, '| median among paid =', paid[Math.floor((paid.length - 1) / 2)]?.toFixed(6), '| min =', paid[0]?.toFixed(6))
  const byMode: Record<string, number> = {}
  for (const r of rows) byMode[r.mode ?? '?'] = (byMode[r.mode ?? '?'] ?? 0) + Number(r.costUSD)
  log('cost by mode:', JSON.stringify(byMode))
})
await safe('timeline day spread', async () => {
  const { getFleetTimeline } = await import('../src/services/agent-fleet/fleet-timeline.service.js')
  const p = await getFleetTimeline({}, { limit: 200 })
  const days: Record<string, number> = {}
  for (const e of p.events) days[e.at.slice(0, 10)] = (days[e.at.slice(0, 10)] ?? 0) + 1
  log('events returned in one 200-page =', p.events.length, '| nextCursor =', p.nextCursor)
  log('events per UTC day:', JSON.stringify(days))
})

await prisma.$disconnect()
