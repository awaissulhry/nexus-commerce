/**
 * NAF.SB.M-S9R Phase 0 — re-measure every inherited raise before acting on it.
 *
 * Read-only. Proves each claim against the database a SECOND way rather than
 * reading the service and reasoning about it.
 */
const { default: prisma } = await import('../src/db.js')
const { getFleetMap } = await import('../src/services/agent-fleet/fleet-map.service.js')

const line = (s: string) => console.log(s)
const hr = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`)

/* ── R2 / caps: are the take() limits anywhere near being hit? ─────────── */
hr('CAPS — what is the real row count against each take()')
const [runTotal, planTotal, findingTotal, approvalTotal] = await Promise.all([
  prisma.agentRun.count({ where: { mode: { not: null } } }),
  prisma.agentPlan.count(),
  prisma.agentFinding.count(),
  prisma.agentApproval.count(),
])
line(`AgentRun (mode not null)  ${runTotal}   vs lastRunRows take: 400   ${runTotal > 400 ? '*** CAP EXCEEDED ***' : `headroom ${400 - runTotal}`}`)
line(`AgentPlan                 ${planTotal}   vs planRows take: 200      ${planTotal > 200 ? '*** CAP EXCEEDED ***' : `headroom ${200 - planTotal}`}`)
line(`AgentFinding (all)        ${findingTotal}`)
line(`AgentApproval (all)       ${approvalTotal}`)

/* ── R2: notOkWindow is derived from the 400-slice; runs.window is not ─── */
hr('R2 — notOkWindow (from take:400) vs a direct groupBy over ALL rows')
const since7d = new Date(Date.now() - 7 * 24 * 3600_000)
const directNotOk = await prisma.agentRun.groupBy({
  by: ['agentKey'],
  where: { mode: { not: null }, createdAt: { gte: since7d }, status: { not: 'running' }, ok: false },
  _count: { _all: true },
})
const directMap = new Map(directNotOk.map((r) => [r.agentKey, r._count._all]))
const m = await getFleetMap('7d')
let mismatches = 0
for (const n of m.nodes) {
  const direct = directMap.get(n.key) ?? 0
  const flag = direct === n.runs.notOkWindow ? '' : '   *** MISMATCH ***'
  if (direct !== n.runs.notOkWindow) mismatches++
  line(`  ${n.key.padEnd(26)} service=${String(n.runs.notOkWindow).padStart(3)}  direct=${String(direct).padStart(3)}${flag}`)
}
line(`mismatches: ${mismatches}  (0 expected while the fleet is under the 400 cap)`)

/* ── R5 / D5: is AgentFinding.planId ever written? ─────────────────────── */
hr('D5 — AgentFinding.planId: declared, indexed, and written?')
const withPlanId = await prisma.agentFinding.count({ where: { planId: { not: null } } })
line(`findings with planId set: ${withPlanId} of ${findingTotal}   ${withPlanId === 0 ? '→ NEVER WRITTEN, D5 still true' : '→ someone writes it now'}`)

/* ── R4: the three-way "today" ─────────────────────────────────────────── */
hr('R4 — "today": UTC day vs local-midnight day')
const now = new Date()
const utcStart = new Date(now); utcStart.setUTCHours(0, 0, 0, 0)
const localStart = new Date(now); localStart.setHours(0, 0, 0, 0)
const [utcSpend, localSpend] = await Promise.all([
  prisma.agentRun.aggregate({ where: { mode: { not: null }, createdAt: { gte: utcStart } }, _sum: { costUSD: true } }),
  prisma.agentRun.aggregate({ where: { mode: { not: null }, createdAt: { gte: localStart } }, _sum: { costUSD: true } }),
])
const n2 = (d: unknown) => (d == null ? 0 : Number(d))
line(`UTC   day start ${utcStart.toISOString()}  spend $${n2(utcSpend._sum.costUSD).toFixed(4)}`)
line(`local day start ${localStart.toISOString()}  spend $${n2(localSpend._sum.costUSD).toFixed(4)}`)
line(`server TZ offset ${-now.getTimezoneOffset() / 60}h — the two windows ${utcStart.getTime() === localStart.getTime() ? 'COINCIDE right now' : 'differ'}`)
line(`disagreement: ${n2(utcSpend._sum.costUSD) === n2(localSpend._sum.costUSD) ? 'none TODAY (both $ equal) — but the boundary still differs' : '*** the two "today" figures differ ***'}`)

/* ── R1: spendLedgerReadable ───────────────────────────────────────────── */
hr('R1 — spendLedgerReadable')
line(`payload value: ${m.state.spendLedgerReadable}  (source is a literal \`true\` at fleet-map.service.ts:723)`)

/* ── truncation reality: recentRuns cap of 5 ───────────────────────────── */
hr('recentRuns cap of 5 — how many nodes are actually capped')
let capped = 0
for (const n of m.nodes) {
  if (n.recentRuns.length === 5 && n.runs.lifetime > 5) {
    capped++
    line(`  ${n.key.padEnd(26)} shows 5 of ${n.runs.lifetime} lifetime runs — payload says nothing about the other ${n.runs.lifetime - 5}`)
  }
}
line(`nodes hitting the cap: ${capped}`)
line(`warnings[] currently: ${JSON.stringify(m.warnings)}`)

await prisma.$disconnect()
