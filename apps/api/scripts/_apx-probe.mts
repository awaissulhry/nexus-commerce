// NAF.APX — READ-ONLY approvals ground-truth probe.
// Run: cd apps/api && npx tsx scripts/_apx-probe.mts
// Contains ONLY findMany / count / groupBy. No create/update/delete/upsert/raw-write.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const line = (s: string) => console.log(s)
const hdr = (s: string) => console.log(`\n===== ${s} =====`)

const tally = <T,>(rows: T[], k: (r: T) => string) => {
  const m = new Map<string, number>()
  for (const r of rows) m.set(k(r), (m.get(k(r)) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

/* ---------------- 1. AgentApproval ---------------- */
hdr('1. AgentApproval')
const approvals = await prisma.agentApproval.findMany({
  select: {
    id: true, agentRunId: true, toolName: true, riskTier: true, status: true,
    reason: true, requestedAt: true, decidedBy: true, decidedAt: true,
    expiresAt: true, executeAfter: true,
  },
  orderBy: { requestedAt: 'asc' },
})
line(`TOTAL approval rows: ${approvals.length}`)
line(`by status:   ${JSON.stringify(tally(approvals, (a) => a.status))}`)
line(`by toolName: ${JSON.stringify(tally(approvals, (a) => a.toolName))}`)
line(`by riskTier: ${JSON.stringify(tally(approvals, (a) => a.riskTier))}`)

/* ---------------- 2. decision quality ---------------- */
hdr('2. decidedBy / reason / latency')
line(`decidedBy set: ${approvals.filter((a) => a.decidedBy).length} / ${approvals.length}`)
line(`decidedAt set: ${approvals.filter((a) => a.decidedAt).length} / ${approvals.length}`)
line(`reason set:    ${approvals.filter((a) => a.reason).length} / ${approvals.length}`)
const decided = approvals.filter((a) => a.decidedAt)
if (decided.length === 0) {
  line('decision latency: N/A — zero rows have decidedAt')
} else {
  const mins = decided
    .map((a) => (a.decidedAt!.getTime() - a.requestedAt.getTime()) / 60000)
    .sort((x, y) => x - y)
  const median = mins.length % 2
    ? mins[(mins.length - 1) / 2]
    : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2
  line(`decision latency mins — min ${mins[0].toFixed(2)} / median ${median.toFixed(2)} / max ${mins[mins.length - 1].toFixed(2)} (n=${mins.length})`)
}

/* ---------------- 3. time window ---------------- */
hdr('3. requestedAt window / pending / expired')
line(`oldest requestedAt: ${approvals[0]?.requestedAt.toISOString() ?? 'n/a (zero rows)'}`)
line(`newest requestedAt: ${approvals[approvals.length - 1]?.requestedAt.toISOString() ?? 'n/a (zero rows)'}`)
const now = new Date()
line(`pending right now: ${approvals.filter((a) => a.status === 'pending').length}`)
line(`scheduled right now: ${approvals.filter((a) => a.status === 'scheduled').length}`)
line(`expiresAt set: ${approvals.filter((a) => a.expiresAt).length}`)
line(`expiresAt in the PAST: ${approvals.filter((a) => a.expiresAt && a.expiresAt < now).length}`)
line(`pending AND expiresAt in the past: ${approvals.filter((a) => a.status === 'pending' && a.expiresAt && a.expiresAt < now).length}`)
line(`executeAfter set: ${approvals.filter((a) => a.executeAfter).length}`)
for (const a of approvals.slice(0, 20)) {
  line(`   ${a.requestedAt.toISOString().slice(0, 16)} ${a.status.padEnd(10)} ${a.riskTier.padEnd(8)} ${a.toolName} run=${a.agentRunId.slice(0, 8)} decidedBy=${a.decidedBy ?? '—'} reason=${a.reason ? JSON.stringify(a.reason).slice(0, 40) : '—'}`)
}

/* ---------------- 4. exemplars + control audit ---------------- */
hdr('4. AgentExemplar / AgentControlAudit')
const exemplars = await prisma.agentExemplar.findMany({
  select: { charterKey: true, label: true, active: true },
})
line(`AgentExemplar rows: ${exemplars.length}`)
if (exemplars.length) {
  line(`  by label:   ${JSON.stringify(tally(exemplars, (e) => e.label))}`)
  line(`  by charter: ${JSON.stringify(tally(exemplars, (e) => e.charterKey))}`)
  line(`  active:     ${exemplars.filter((e) => e.active).length}`)
}
const audits = await prisma.agentControlAudit.findMany({
  select: { charterKey: true, action: true, actor: true, toValue: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
})
line(`AgentControlAudit rows: ${audits.length}`)
if (audits.length) {
  line(`  by action:  ${JSON.stringify(tally(audits, (a) => a.action))}`)
  line(`  by charter: ${JSON.stringify(tally(audits, (a) => a.charterKey))}`)
  line(`  by actor:   ${JSON.stringify(tally(audits, (a) => a.actor ?? '(null)'))}`)
  line(`  window: ${audits[0].createdAt.toISOString()} .. ${audits[audits.length - 1].createdAt.toISOString()}`)
  const dials = audits.filter((a) => a.action === 'dial')
  line(`  dial events: ${dials.length}`)
  const everProposeOrAbove = dials.filter((d) => {
    const s = JSON.stringify(d.toValue ?? '')
    return s.includes('PROPOSE') || s.includes('AUTO')
  })
  line(`  dial events that set PROPOSE or AUTO: ${everProposeOrAbove.length}`)
  for (const d of everProposeOrAbove.slice(0, 10)) {
    line(`     ${d.createdAt.toISOString().slice(0, 16)} ${d.charterKey} -> ${JSON.stringify(d.toValue)}`)
  }
}

/* ---------------- 5. AgentRun ---------------- */
hdr('5. AgentRun')
const totalRuns = await prisma.agentRun.count()
line(`TOTAL AgentRun rows: ${totalRuns}`)
const byMode = await prisma.agentRun.groupBy({ by: ['mode'], _count: { _all: true } })
line(`by mode: ${JSON.stringify(byMode.map((r) => [r.mode ?? '(null = non-fleet)', r._count._all]))}`)
const byOk = await prisma.agentRun.groupBy({ by: ['ok'], _count: { _all: true } })
line(`by ok: ${JSON.stringify(byOk.map((r) => [r.ok ? 'ok' : 'FAILED', r._count._all]))}`)
const byStatus = await prisma.agentRun.groupBy({ by: ['status'], _count: { _all: true } })
line(`by status: ${JSON.stringify(byStatus.map((r) => [r.status, r._count._all]))}`)
const fleetRuns = await prisma.agentRun.count({ where: { mode: { not: null } } })
line(`fleet runs (mode NOT NULL): ${fleetRuns}`)
const byKeyMode = await prisma.agentRun.groupBy({
  by: ['agentKey', 'mode'],
  where: { mode: { not: null } },
  _count: { _all: true },
})
line(`fleet runs by agentKey+mode: ${JSON.stringify(byKeyMode.map((r) => [r.agentKey, r.mode, r._count._all]))}`)
const awaiting = await prisma.agentRun.count({ where: { status: 'awaiting_approval' } })
line(`runs with status='awaiting_approval': ${awaiting}`)
const runsWithApprovals = await prisma.agentRun.count({ where: { approvals: { some: {} } } })
line(`runs that ever produced >=1 approval (proxy for reaching PROPOSE): ${runsWithApprovals}`)
const halted = await prisma.agentRun.count({ where: { haltedReason: { not: null } } })
line(`runs with haltedReason set: ${halted}`)
const firstRun = await prisma.agentRun.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
const lastRun = await prisma.agentRun.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, agentKey: true, mode: true } })
line(`run window: ${firstRun?.createdAt.toISOString() ?? 'n/a'} .. ${lastRun?.createdAt.toISOString() ?? 'n/a'} (last: ${lastRun?.agentKey ?? '—'}/${lastRun?.mode ?? '—'})`)

/* ---------------- 6. charter autonomy ---------------- */
hdr('6. Charter autonomy (raw rows)')
const charters = await prisma.agentCharter.findMany({
  select: {
    key: true, version: true, name: true, tier: true, enabled: true,
    autonomyLevel: true, autonomyCap: true, templateKey: true,
    pausedUntil: true, supersededBy: true, cadence: true, updatedAt: true,
  },
  orderBy: [{ key: 'asc' }, { version: 'asc' }],
})
line(`AgentCharter rows: ${charters.length}`)
for (const c of charters) {
  line(`  ${c.enabled ? 'ON ' : 'off'} ${c.key}@v${c.version} tier=${c.tier} dial=${c.autonomyLevel} cap=${c.autonomyCap}${c.templateKey ? ` (instance of ${c.templateKey})` : ''}${c.supersededBy ? ` superseded=${c.supersededBy}` : ''} paused=${c.pausedUntil?.toISOString() ?? '—'} cadence=${c.cadence ?? '—'}`)
}
line(`rows with autonomyLevel != 'OFF': ${charters.filter((c) => c.autonomyLevel !== 'OFF').length}`)
line(`rows with autonomyLevel in (PROPOSE,AUTO): ${charters.filter((c) => c.autonomyLevel === 'PROPOSE' || c.autonomyLevel === 'AUTO').length}`)
line(`rows enabled: ${charters.filter((c) => c.enabled).length}`)

hdr('6b. Effective autonomy via listCharters() (code ⊕ db, read-only)')
try {
  const { listCharters } = await import('../src/services/agent-fleet/charter-registry.js')
  const eff = await listCharters()
  for (const c of eff) {
    line(`  ${c.enabled ? 'ON ' : 'off'} ${c.key} effAutonomy=${c.autonomyLevel} cap=${c.autonomyCap} provisioned=${String((c as { provisioned?: unknown }).provisioned)} degraded=${String((c as { degraded?: unknown }).degraded)}`)
  }
  line(`effective above OBSERVE (PROPOSE|AUTO): ${eff.filter((c) => c.autonomyLevel === 'PROPOSE' || c.autonomyLevel === 'AUTO').length}`)
  line(`effective at OBSERVE: ${eff.filter((c) => c.autonomyLevel === 'OBSERVE').length}`)
  line(`effective at OFF: ${eff.filter((c) => c.autonomyLevel === 'OFF').length}`)
} catch (e) {
  line(`listCharters() unavailable: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`)
}

/* ---------------- 7. adjacent tables for context ---------------- */
hdr('7. adjacent fleet tables (context)')
for (const [name, fn] of [
  ['AgentFinding', () => prisma.agentFinding.count()],
  ['AgentPlan', () => prisma.agentPlan.count()],
  ['AgentObservation', () => prisma.agentObservation.count()],
  ['AgentCharterRevision', () => prisma.agentCharterRevision.count()],
  ['AgentScorecard', () => prisma.agentScorecard.count()],
  ['AgentShadowGrade', () => prisma.agentShadowGrade.count()],
  ['AgentWorkflow', () => prisma.agentWorkflow.count()],
  ['AgentFleetState', () => prisma.agentFleetState.count()],
  ['AgentTool', () => prisma.agentTool.count()],
] as [string, () => Promise<number>][]) {
  try {
    line(`${name}: ${await fn()}`)
  } catch (e) {
    line(`${name}: ERROR ${e instanceof Error ? e.message.slice(0, 80) : e}`)
  }
}

/* ---------------- 8. provenance of the approvals ---------------- */
hdr('8. which runs produced the approvals')
const approvalRunIds = [...new Set(approvals.map((a) => a.agentRunId))]
line(`distinct agentRunIds on approvals: ${approvalRunIds.length}`)
const approvalRuns = await prisma.agentRun.findMany({
  where: { id: { in: approvalRunIds } },
  select: { id: true, agentKey: true, mode: true, trigger: true, status: true, userId: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
})
line(`resolved runs: ${approvalRuns.length}`)
line(`  by agentKey: ${JSON.stringify(tally(approvalRuns, (r) => r.agentKey))}`)
line(`  by mode:     ${JSON.stringify(tally(approvalRuns, (r) => r.mode ?? '(null = NOT a fleet run)'))}`)
line(`  by trigger:  ${JSON.stringify(tally(approvalRuns, (r) => r.trigger))}`)
line(`  by userId:   ${JSON.stringify(tally(approvalRuns, (r) => r.userId ?? '(null)'))}`)
const fleetApprovals = approvalRuns.filter((r) => r.mode != null).length
line(`approval-producing runs that are FLEET runs (mode NOT NULL): ${fleetApprovals}`)

const withPreview = await prisma.agentApproval.count({ where: { NOT: { preview: { equals: null } } } })
line(`approvals with a preview payload: ${withPreview} / ${approvals.length}`)

const plan = await prisma.agentPlan.findMany({
  select: { id: true, status: true, criticVerdict: true, approvalIds: true, createdAt: true },
})
for (const p of plan) line(`AgentPlan ${p.createdAt.toISOString().slice(0, 16)} status=${p.status} critic=${p.criticVerdict} approvalIds=${JSON.stringify(p.approvalIds)}`)

await prisma.$disconnect()
