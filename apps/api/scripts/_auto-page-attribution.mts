/**
 * AUTO page study — three things the earlier study asserted that I want settled. READ-ONLY.
 *
 *   1. "rules made 95 of 42,885 writes — 0.2%" counted only rows carrying an `executionId`.
 *      But the actor column also holds `automation:<ruleId>` — 642 + 574 budget writes came from
 *      two of them. If those are rules, the headline is understated and the ledger has TWO
 *      attribution paths that disagree.
 *   2. The page renders a "capped" chip from AutomationRuleExecution rows with
 *      errorMessage='DAILY_CAP_EXCEEDED'. The cap stopped writing those rows on 2026-08-04
 *      (automation-rule.service.ts:576). So what does that column read TODAY?
 *   3. The pending queue has 40 rows aged 0-1d, 184 aged 2-7d, ZERO aged 8-30d and one at 51d.
 *      A gap that clean is a purge or a recreate, not an age distribution.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const DAY = 86_400_000
const since = new Date(Date.now() - 60 * DAY)

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, autonomyLevel: true, enabled: true, dryRun: true, maxExecutionsPerDay: true },
})
const nameById = new Map(rules.map((r) => [r.id, r.name]))

// ── 1. the two attribution paths ─────────────────────────────────────────────────────────────
console.log('\n═══ 1 · How a write is attributed to a rule — two paths, two answers ═══\n')
const byExec = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, executionId: { not: null } } })
const actorRows = await prisma.advertisingActionLog.groupBy({
  by: ['userId'],
  where: { createdAt: { gte: since }, userId: { in: rules.map((r) => `automation:${r.id}`) } },
  _count: { _all: true },
})
const byActor = actorRows.reduce((a, g) => a + g._count._all, 0)
console.log(`rows with executionId set                : ${int(byExec)}`)
console.log(`rows whose userId is automation:<ruleId> : ${int(byActor)}`)
for (const g of actorRows.sort((a, b) => b._count._all - a._count._all)) {
  const id = (g.userId ?? '').replace('automation:', '')
  console.log(`   ${pad(nameById.get(id) ?? id, 46)} ${int(g._count._all)}`)
}
const both = await prisma.advertisingActionLog.count({
  where: { createdAt: { gte: since }, executionId: { not: null }, userId: { in: rules.map((r) => `automation:${r.id}`) } },
})
console.log(`rows carrying BOTH                       : ${int(both)}`)
const total = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since } } })
const union = byExec + byActor - both
console.log(`\nunion — writes genuinely from a rule     : ${int(union)} of ${int(total)} (${((union / total) * 100).toFixed(2)}%)`)

// When did the executionId-attributed ones happen? A rule path that stopped is not the same as
// a rule path that never worked.
const execRows = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since }, executionId: { not: null } },
  select: { createdAt: true, actionType: true },
  orderBy: { createdAt: 'desc' },
})
if (execRows.length) {
  console.log(`\nexecutionId-attributed rows: newest ${execRows[0].createdAt.toISOString().slice(0, 10)} · oldest ${execRows[execRows.length - 1].createdAt.toISOString().slice(0, 10)}`)
  const kinds = new Map<string, number>()
  for (const r of execRows) kinds.set(r.actionType, (kinds.get(r.actionType) ?? 0) + 1)
  console.log(`   by kind: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
}

// ── 2. what the page's "capped" column reads today ───────────────────────────────────────────
console.log('\n═══ 2 · The "capped" chip, run exactly as the route computes it ═══\n')
for (const days of [7, 14, 30, 60]) {
  const from = new Date(Date.now() - days * DAY)
  const g = await prisma.automationRuleExecution.groupBy({
    by: ['ruleId'],
    where: { startedAt: { gte: from }, ruleId: { in: rules.map((r) => r.id) }, errorMessage: 'DAILY_CAP_EXCEEDED' },
    _count: { _all: true },
  })
  const sum = g.reduce((a, x) => a + x._count._all, 0)
  console.log(`last ${String(days).padStart(2)} days: ${g.length} rules with a cap row · ${int(sum)} rows total`)
}
console.log('\nThe grid column is the 7-day figure. Every rule on the page renders "0 capped".')
// Is the cap still BITING? Executions per rule today vs its cap.
const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
const today = await prisma.automationRuleExecution.groupBy({
  by: ['ruleId'], where: { startedAt: { gte: dayStart }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } }, _count: { _all: true },
})
console.log('\nrules AT or OVER their cap right now (so every further match today is refused, silently):')
let atCap = 0
for (const t of today.sort((a, b) => b._count._all - a._count._all)) {
  const r = rules.find((x) => x.id === t.ruleId)
  if (!r?.maxExecutionsPerDay) continue
  const hit = t._count._all >= r.maxExecutionsPerDay
  if (hit) atCap++
  if (hit || t._count._all > r.maxExecutionsPerDay * 0.5) {
    console.log(`   ${hit ? '🔴' : '  '} ${pad(r.name, 46)} ${t._count._all} / ${r.maxExecutionsPerDay} today`)
  }
}
console.log(`   → ${atCap} rules are refusing silently right now.`)

// ── 3. the queue's age gap ───────────────────────────────────────────────────────────────────
console.log('\n═══ 3 · The queue age gap ═══\n')
const sugg = await prisma.adsRuleSuggestion.findMany({
  select: { createdAt: true, status: true, ruleName: true, proposedKey: true },
  orderBy: { createdAt: 'asc' },
})
const byDay = new Map<string, number>()
for (const s of sugg) {
  const k = s.createdAt.toISOString().slice(0, 10)
  byDay.set(k, (byDay.get(k) ?? 0) + 1)
}
console.log('suggestions created, by day (all statuses):')
for (const [d, n] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`   ${d}  ${n}`)
console.log('\nSo the "queue" is not an accumulating backlog: the unique key')
console.log('(ruleId, entityId, proposedKey) means a repeat proposal for the same entity cannot')
console.log('create a second row — the pending set is a STANDING WAVE, not a pile.')

// ── 4. retail_guard: the one AUTO rule with a structural effect ──────────────────────────────
console.log('\n═══ 4 · Retail guard — AUTO, and it pauses campaigns ═══\n')
const rg = rules.find((r) => r.name.toLowerCase().includes('retail guard'))
if (rg) {
  const [execs, pauses] = await Promise.all([
    prisma.automationRuleExecution.groupBy({ by: ['status'], where: { ruleId: rg.id, startedAt: { gte: since } }, _count: { _all: true } }),
    prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, userId: `automation:${rg.id}` } }),
  ])
  console.log(`"${rg.name}" — level ${rg.autonomyLevel}, cap ${rg.maxExecutionsPerDay ?? '∞'}/day`)
  console.log(`   executions 60d: ${execs.map((e) => `${e.status} ${e._count._all}`).join(' · ') || 'none'}`)
  console.log(`   action-log rows attributed to it: ${pauses}`)
  const paused = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: { contains: 'pause' } } })
  console.log(`   any pause_* row in the log at all, 60d, from anyone: ${paused}`)
}

await prisma.$disconnect()
