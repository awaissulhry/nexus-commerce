/**
 * BS — Budget Schedules tab study. READ-ONLY: no writes, no mutations.
 *
 * The tab owns ONE object (`BudgetSchedule`) and one executor (`ad-budget-schedule` cron).
 * But five different things in this codebase can move a campaign's daily budget. This measures
 * the tab's own object, its executor, every competing system, and the hourly signal a budget
 * schedule is supposed to exploit.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log('\n═══ BS — Budget Schedules ═══\n')

// ── 1. the tab's own object ───────────────────────────────────────────────────
const [all, enabled, byKind] = await Promise.all([
  prisma.budgetSchedule.count(),
  prisma.budgetSchedule.count({ where: { enabled: true } }),
  prisma.budgetSchedule.groupBy({ by: ['kind', 'type'], _count: { _all: true } }).catch(() => []),
])
console.log(`BudgetSchedule rows: ${all}  (enabled ${enabled})`)
for (const k of byKind) console.log(`    kind=${k.kind} type=${k.type}: ${k._count._all}`)

// ── 2. its executor ───────────────────────────────────────────────────────────
const crons = await prisma.cronRun.groupBy({
  by: ['jobName'],
  where: { jobName: { in: ['ad-budget-schedule', 'budget-schedule', 'ad-budget-enforce', 'budget-pool-rebalance', 'ads-auto-bid', 'ad-autopilot'] } },
  _count: { _all: true }, _max: { startedAt: true },
})
console.log(`\n── every cron that can move a daily budget ──`)
for (const name of ['ad-budget-schedule', 'budget-schedule', 'ad-budget-enforce', 'budget-pool-rebalance', 'ad-autopilot']) {
  const c = crons.find((x) => x.jobName === name)
  console.log(`  ${pad(name, 26)} ${c ? `runs=${String(int(c._count._all)).padStart(7)}  last=${c._max.startedAt?.toISOString().slice(0, 16)}` : 'NEVER RUN'}`)
}

// ── 3. the competing systems ──────────────────────────────────────────────────
console.log(`\n── the other things that move a daily budget ──`)
const budgetRules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { name: true, enabled: true, autonomyLevel: true, actions: true, executionCount: true, lastExecutedAt: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const budgetActs = ['adjust_ad_budget', 'budget_apply', 'shift_budget']
const bRules = budgetRules.filter((r) => types(r.actions).some((t) => budgetActs.includes(t)))
console.log(`\n  1. AutomationRule (the "Budget" tab): ${bRules.length} rules`)
for (const r of bRules) console.log(`     ${pad(r.name, 42)} enabled=${String(r.enabled).padEnd(5)} ${pad(String(r.autonomyLevel), 8)} execs=${String(r.executionCount).padStart(6)} last=${r.lastExecutedAt?.toISOString().slice(0, 10) ?? 'never'}`)

const [pools, allocs, rebals] = await Promise.all([
  prisma.budgetPool.count().catch(() => -1),
  prisma.budgetPoolAllocation.count().catch(() => -1),
  prisma.budgetPoolRebalance.count().catch(() => -1),
])
console.log(`\n  2. BudgetPool: ${pools} pools · ${allocs} allocations · ${rebals} rebalances`)

const plans = await prisma.adBudgetPlan.findMany({ select: { id: true, name: true, mode: true, enabled: true } }).catch(() => null)
if (plans) {
  console.log(`\n  3. AdBudgetPlan (Budget Manager): ${plans.length}`)
  for (const p of plans) console.log(`     ${pad(p.name, 42)} mode=${p.mode} enabled=${p.enabled}`)
} else {
  const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = 'AdBudgetPlan'`
  console.log(`\n  3. AdBudgetPlan columns: ${cols.map((c) => c.column_name).join(', ')}`)
}

const autopilot = await prisma.autopilotPlan.count().catch(() => -1)
console.log(`\n  4. AutopilotPlan (has a budget module): ${autopilot}`)
console.log(`  5. ad-rank-defend suppresses on over-budget (suppressRaise) — indirect`)

// ── 4. what the campaigns' budgets actually look like ─────────────────────────
const camps = await prisma.campaign.findMany({
  select: { id: true, name: true, marketplace: true, status: true, dailyBudget: true, liveBidWritesEnabled: true },
})
const live = camps.filter((c) => c.status === 'ENABLED')
const budgets = live.map((c) => Number(c.dailyBudget ?? 0)).filter((b) => b > 0).sort((a, b) => a - b)
const at = (p: number) => budgets[Math.min(budgets.length - 1, Math.floor(budgets.length * p))] ?? 0
console.log(`\n── daily budgets, ${live.length} ENABLED campaigns ──`)
console.log(`  total committed/day : €${budgets.reduce((a, b) => a + b, 0).toFixed(2)}`)
console.log(`  min ${at(0).toFixed(2)} · p25 €${at(0.25).toFixed(2)} · median €${at(0.5).toFixed(2)} · p75 €${at(0.75).toFixed(2)} · max €${at(1).toFixed(2)}`)

// ── 5. the signal a budget schedule exists to exploit ─────────────────────────
const hourly = await prisma.$queryRaw<Array<{ hour: number; cost: bigint | null; sales: bigint | null; clicks: bigint | null; orders: bigint | null }>>`
  SELECT EXTRACT(HOUR FROM (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome'))::int AS hour,
         SUM("costMicros") AS cost, SUM(COALESCE("sales7dCents",0)) AS sales,
         SUM("clicks") AS clicks, SUM(COALESCE("orders7d",0)) AS orders
  FROM "AmazonAdsHourlyPerformance"
  WHERE "date" >= NOW() - INTERVAL '60 days'
  GROUP BY 1 ORDER BY 1`
if (hourly.length) {
  const rows = hourly.map((r) => {
    const spend = Number(r.cost ?? 0n) / 1e6, sales = Number(r.sales ?? 0n) / 100
    return { hour: Number(r.hour), spend, sales, roas: spend > 0 ? sales / spend : 0, clicks: Number(r.clicks ?? 0n), orders: Number(r.orders ?? 0n) }
  })
  const totalSpend = rows.reduce((a, r) => a + r.spend, 0)
  const sorted = [...rows].sort((a, b) => b.roas - a.roas)
  console.log(`\n── hour-of-day performance (Europe/Rome, 60d) — the signal a schedule exploits ──`)
  console.log(`  BEST 6 hours by ROAS:`)
  for (const r of sorted.slice(0, 6)) console.log(`    ${String(r.hour).padStart(2, '0')}:00  ROAS ${r.roas.toFixed(2).padStart(6)}  spend €${r.spend.toFixed(2).padStart(8)}  (${((r.spend / totalSpend) * 100).toFixed(1)}% of spend)`)
  console.log(`  WORST 6 hours by ROAS:`)
  for (const r of sorted.slice(-6).reverse()) console.log(`    ${String(r.hour).padStart(2, '0')}:00  ROAS ${r.roas.toFixed(2).padStart(6)}  spend €${r.spend.toFixed(2).padStart(8)}  (${((r.spend / totalSpend) * 100).toFixed(1)}% of spend)`)
  const best6 = sorted.slice(0, 6).reduce((a, r) => a + r.spend, 0)
  const worst6 = sorted.slice(-6).reduce((a, r) => a + r.spend, 0)
  console.log(`\n  spend in the 6 best hours : €${best6.toFixed(2)}  (${((best6 / totalSpend) * 100).toFixed(1)}%)`)
  console.log(`  spend in the 6 worst hours: €${worst6.toFixed(2)}  (${((worst6 / totalSpend) * 100).toFixed(1)}%)`)
  console.log(`  ← the gap between these two is the entire business case for a budget schedule`)
}

// ── 6. does anything actually run out of budget? ──────────────────────────────
const oob = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM information_schema.columns
  WHERE table_name = 'AmazonAdsDailyPerformance' AND column_name ILIKE '%budget%'`
console.log(`\n  (AmazonAdsDailyPerformance budget-ish columns: ${Number(oob[0]?.n ?? 0)})`)

await prisma.$disconnect()
