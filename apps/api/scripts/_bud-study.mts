/**
 * BUD — Budget tab study. READ-ONLY: no writes, no mutations.
 *
 * Six rules whose action is `adjust_ad_budget`. Two are on AUTO and have executed 2,223 times
 * between them. The question this measures: how many of those executions actually moved a budget,
 * on which campaigns, and what stopped the rest.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log('\n═══ BUD — Budget ═══\n')

// ── 1. the six rules, in full ─────────────────────────────────────────────────
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, description: true, enabled: true, autonomyLevel: true, dryRun: true,
    trigger: true, conditions: true, actions: true,
    maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
    evaluationCount: true, matchCount: true, executionCount: true,
    lastEvaluatedAt: true, lastMatchedAt: true, lastExecutedAt: true, createdAt: true,
  },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((t) => t === 'adjust_ad_budget'))
console.log(`Rules on the Budget tab: ${rules.length}\n`)
for (const r of rules) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const budgetAct = acts.find((a) => a.type === 'adjust_ad_budget') ?? {}
  console.log(`▸ ${r.name}`)
  console.log(`   enabled=${r.enabled}  level=${r.autonomyLevel}  trigger=${r.trigger}`)
  console.log(`   action  : ${budgetAct.percent != null ? `${Number(budgetAct.percent) > 0 ? '+' : ''}${budgetAct.percent}%` : budgetAct.newDailyBudget != null ? `set €${budgetAct.newDailyBudget}` : '?'}   (${acts.length} action(s) total: ${types(r.actions).join(', ')})`)
  const conds = (Array.isArray(r.conditions) ? r.conditions : []) as Array<Record<string, unknown>>
  for (const c of conds.slice(0, 2)) {
    const inner = (Array.isArray(c.conditions) ? c.conditions : []) as Array<Record<string, unknown>>
    console.log(`   if      : ${inner.map((x) => `${x.metric} ${x.op} ${x.value}`).join(' AND ') || JSON.stringify(c).slice(0, 110)}`)
  }
  console.log(`   caps    : execs/day=${r.maxExecutionsPerDay ?? '—'}  maxValue=${r.maxValueCentsEur != null ? `€${(r.maxValueCentsEur / 100).toFixed(2)}` : '—'}  dailyAdSpend=${r.maxDailyAdSpendCentsEur != null ? `€${(r.maxDailyAdSpendCentsEur / 100).toFixed(2)}` : '— (UNCAPPED)'}`)
  console.log(`   scope   : mkt=${r.scopeMarketplace ?? 'ALL'} portfolio=${r.scopePortfolioId ?? '—'} campaign=${r.scopeCampaignId ?? '—'} product=${r.scopeProductId ?? '—'}`)
  console.log(`   counters: evals=${int(r.evaluationCount)} matches=${int(r.matchCount)} execs=${int(r.executionCount)}  last exec ${r.lastExecutedAt?.toISOString().slice(0, 16) ?? 'never'}`)
  console.log('')
}

// ── 2. what the executions actually did ───────────────────────────────────────
const ids = rules.map((r) => r.id)
const since = new Date(Date.now() - 60 * 86_400_000)
const outcomes = await prisma.automationRuleExecution.groupBy({
  by: ['ruleId', 'status'],
  where: { ruleId: { in: ids }, startedAt: { gte: since } },
  _count: { _all: true },
})
const capRows = await prisma.automationRuleExecution.groupBy({
  by: ['ruleId'],
  where: { ruleId: { in: ids }, startedAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' },
  _count: { _all: true },
})
const capBy = new Map(capRows.map((c) => [c.ruleId, c._count._all]))
console.log(`── execution outcomes, 60d ──`)
console.log(`${pad('rule', 40)} ${pad('SUCCESS', 8)} ${pad('NO_MATCH', 9)} ${pad('FAILED', 7)} ${pad('other', 7)} DAILY_CAP`)
for (const r of rules) {
  const mine = outcomes.filter((o) => o.ruleId === r.id)
  const g = (s: string) => mine.find((m) => m.status === s)?._count._all ?? 0
  const other = mine.filter((m) => !['SUCCESS', 'NO_MATCH', 'FAILED'].includes(m.status)).reduce((a, m) => a + m._count._all, 0)
  console.log(`${pad(r.name, 40)} ${pad(int(g('SUCCESS')), 8)} ${pad(int(g('NO_MATCH')), 9)} ${pad(int(g('FAILED')), 7)} ${pad(int(other), 7)} ${int(capBy.get(r.id) ?? 0)}`)
}

// ── 3. did a budget actually change? ──────────────────────────────────────────
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since }, actionType: { contains: 'budget', mode: 'insensitive' } },
  select: { actionType: true, entityType: true, entityId: true, actor: true, beforeValue: true, afterValue: true, createdAt: true, status: true },
  orderBy: { createdAt: 'desc' },
  take: 4000,
}).catch(() => [])
console.log(`\n── AdvertisingActionLog rows mentioning budget, 60d: ${int(logs.length)} ──`)
if (logs.length) {
  const byActor = new Map<string, number>()
  for (const l of logs) byActor.set(String(l.actor ?? '—'), (byActor.get(String(l.actor ?? '—')) ?? 0) + 1)
  console.log(`  by actor:`)
  for (const [a, n] of [...byActor].sort((x, y) => y[1] - x[1]).slice(0, 12)) console.log(`    ${pad(a, 46)} ${int(n)}`)
  const byStatus = new Map<string, number>()
  for (const l of logs) byStatus.set(String(l.status ?? '—'), (byStatus.get(String(l.status ?? '—')) ?? 0) + 1)
  console.log(`  by status: ${[...byStatus].map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
  console.log(`  most recent 8:`)
  for (const l of logs.slice(0, 8)) {
    console.log(`    ${l.createdAt.toISOString().slice(0, 16)} ${pad(String(l.actionType), 22)} ${pad(String(l.beforeValue ?? '—'), 10)} → ${pad(String(l.afterValue ?? '—'), 10)} ${String(l.actor ?? '')}`)
  }
}

// ── 4. 🔴 the €1 floor — can these rules do anything at all? ──────────────────
const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, dailyBudget: true, marketplace: true, liveBidWritesEnabled: true },
})
const b = (c: (typeof camps)[number]) => Number(c.dailyBudget ?? 0)
const atFloor = camps.filter((c) => b(c) <= 1)
// a −15% trim floors to €1; below ~€1.18 the trim is a no-op after the floor+rounding
const trimNoop = camps.filter((c) => Math.max(1, Math.round(b(c) * 0.85 * 100) / 100) === b(c))
const trim20Noop = camps.filter((c) => Math.max(1, Math.round(b(c) * 0.80 * 100) / 100) === b(c))
console.log(`\n── 🔴 the €1 floor vs the trim rules ──`)
console.log(`  ENABLED campaigns                         : ${camps.length}`)
console.log(`  already at or below the €1 floor          : ${atFloor.length}`)
console.log(`  where a −15% trim changes NOTHING         : ${trimNoop.length}  ("Trim budget on weak ACOS")`)
console.log(`  where a −20% trim changes NOTHING         : ${trim20Noop.length}  ("Campaign ACOS rebalance")`)
console.log(`  where the write gate is CLOSED anyway     : ${camps.filter((c) => !c.liveBidWritesEnabled).length}`)
const actionable = camps.filter((c) => !trimNoop.includes(c) && c.liveBidWritesEnabled)
console.log(`  campaigns a trim rule can actually move   : ${actionable.length}`)
for (const c of actionable.slice(0, 12)) console.log(`     ${pad(c.name, 46)} [${c.marketplace}] €${b(c).toFixed(2)}`)

// ── 5. the signal the rules read ──────────────────────────────────────────────
const since7 = new Date(Date.now() - 7 * 86_400_000)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'CAMPAIGN', localEntityId: { in: camps.map((c) => c.id) }, date: { gte: since7 } },
  _sum: { costMicros: true },
})
const spendBy = new Map(perf.map((p) => [p.localEntityId!, Number(p._sum.costMicros ?? 0n) / 1e6]))
const utils = camps
  .map((c) => ({ c, util: b(c) > 0 ? (spendBy.get(c.id) ?? 0) / 7 / b(c) : null }))
  .filter((x) => x.util != null) as Array<{ c: (typeof camps)[number]; util: number }>
utils.sort((x, y) => y.util - x.util)
console.log(`\n── budget utilisation (7d avg daily spend ÷ daily budget) — the "budget-capped" signal ──`)
console.log(`  campaigns with spend in the window: ${utils.length}`)
console.log(`  ≥90% utilised (budget-capped)     : ${utils.filter((u) => u.util >= 0.9).length}`)
console.log(`  ≤25% utilised (over-budgeted)     : ${utils.filter((u) => u.util <= 0.25).length}`)
console.log(`  top 8 by utilisation:`)
for (const u of utils.slice(0, 8)) console.log(`     ${pad(u.c.name, 46)} €${b(u.c).toFixed(2)}/day  ${(u.util * 100).toFixed(0)}% utilised`)

await prisma.$disconnect()
