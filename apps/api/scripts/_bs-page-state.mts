/**
 * BS page study — part 1. Object state, engines, and the precedence collision. READ-ONLY.
 * Every zero is verified against an unfiltered count so a wrong filter cannot fake one.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const eur = (c: number) => `€${(c / 100).toFixed(2)}`

// ── 1 · The object, verified both ways ────────────────────────────────────────
const bsAll = await prisma.budgetSchedule.count()
const bsByKind = await prisma.budgetSchedule.groupBy({ by: ['kind', 'enabled'], _count: { _all: true } })
console.log(`\n=== 1 · BudgetSchedule ===`)
console.log(`  total rows (NO filter): ${bsAll}`)
if (bsByKind.length === 0) console.log('  groupBy returned no groups — the table is genuinely empty')
for (const g of bsByKind) console.log(`  kind=${g.kind} enabled=${g.enabled}: ${g._count._all}`)
// prove the query path works at all by counting a table we know is populated
const campAll = await prisma.campaign.count()
console.log(`  control: Campaign rows = ${campAll} (proves the client + connection are live)`)

// ── 2 · Every engine that can move a daily budget ─────────────────────────────
console.log(`\n=== 2 · Engines ===`)
const JOBS = ['ad-budget-schedule', 'ad-budget-enforce', 'budget-pool-rebalance', 'ad-autopilot', 'advertising-rule-evaluator', 'ad-rank-defend', 'ad-dayparting']
for (const j of JOBS) {
  const n = await prisma.cronRun.count({ where: { jobName: j } })
  const last = await prisma.cronRun.findFirst({ where: { jobName: j }, orderBy: { startedAt: 'desc' } })
  const fails = await prisma.cronRun.count({ where: { jobName: j, status: 'FAILED' } })
  console.log(`  ${j.padEnd(28)} runs=${String(n).padStart(6)} failed=${fails} last=${last?.startedAt.toISOString() ?? '—'} status=${last?.status ?? '—'}`)
  const msgs = await prisma.cronRun.findMany({ where: { jobName: j, status: 'SUCCESS' }, orderBy: { startedAt: 'desc' }, take: 3, select: { outputSummary: true, startedAt: true } })
  for (const m of msgs) console.log(`      ${m.startedAt.toISOString().slice(5, 16)}  ${String(m.outputSummary ?? '—').slice(0, 160)}`)
}
// the rows those engines operate on
console.log(`  --- rows each engine iterates ---`)
console.log(`  BudgetSchedule   : ${bsAll}`)
console.log(`  BudgetPool       : ${await prisma.budgetPool.count()}`)
console.log(`  AutopilotPlan    : ${await prisma.autopilotPlan.count()}`)
console.log(`  AdBudgetPlan     : ${await prisma.adBudgetPlan.count()}  (this month: ${await prisma.adBudgetPlan.count({ where: { month: new Date().toISOString().slice(0, 7) } })})`)

// ── 3 · Daily-budget distribution, today ──────────────────────────────────────
console.log(`\n=== 3 · Daily budgets, ENABLED campaigns ===`)
const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, marketplace: true, dailyBudget: true } })
const budgets = camps.map((c) => Math.round(Number(c.dailyBudget ?? 0) * 100)).sort((a, b) => a - b)
const q = (p: number) => budgets[Math.min(budgets.length - 1, Math.max(0, Math.floor(budgets.length * p)))] ?? 0
console.log(`  n=${budgets.length}  total=${eur(budgets.reduce((s, x) => s + x, 0))}/day`)
console.log(`  min=${eur(q(0))} p25=${eur(q(0.25))} median=${eur(q(0.5))} p75=${eur(q(0.75))} p90=${eur(q(0.9))} max=${eur(budgets[budgets.length - 1] ?? 0)}`)
console.log(`  at the €1.00 floor: ${budgets.filter((b) => b <= 100).length} of ${budgets.length}`)
console.log(`  above €2.00:        ${budgets.filter((b) => b > 200).length}`)
console.log(`  above €5.00:        ${budgets.filter((b) => b > 500).length}`)

// ── 4 · Who writes AD_BUDGET_UPDATE, and do they collide? ─────────────────────
console.log(`\n=== 4 · Budget writers, last 14 days ===`)
const since14 = new Date(Date.now() - 14 * 86400000)
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: since14 } },
  select: { entityId: true, userId: true, createdAt: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`  rows: ${logs.length}`)
const byWriter = new Map<string, number>()
for (const l of logs) byWriter.set(l.userId ?? 'null', (byWriter.get(l.userId ?? 'null') ?? 0) + 1)
for (const [w, n] of [...byWriter].sort((a, b) => b[1] - a[1])) console.log(`    ${String(w).slice(0, 46).padEnd(46)} ${n}`)
const byStatus = new Map<string, number>()
for (const l of logs) byStatus.set(l.amazonResponseStatus ?? 'null', (byStatus.get(l.amazonResponseStatus ?? 'null') ?? 0) + 1)
console.log(`  amazonResponseStatus: ${[...byStatus].map(([k, v]) => `${k}=${v}`).join(' · ')}`)

// classify a writer into a system
const sysOf = (u: string | null): string => {
  const s = u ?? 'null'
  if (s.includes('budget-manager')) return 'pacing (ad-budget-enforce)'
  if (s.includes('budget-schedule')) return 'budget schedule'
  if (s.startsWith('automation:')) return 'automation rule'
  if (s.startsWith('user:')) return 'human'
  return 'other/' + s
}
// collisions: same campaign written by two DIFFERENT systems on the same calendar day / same hour
const dayKey = (d: Date) => d.toISOString().slice(0, 13) // hour bucket
const perCampDay = new Map<string, Set<string>>()
const perCampHour = new Map<string, Set<string>>()
for (const l of logs) {
  const d = `${l.entityId}|${l.createdAt.toISOString().slice(0, 10)}`
  const h = `${l.entityId}|${dayKey(l.createdAt)}`
  if (!perCampDay.has(d)) perCampDay.set(d, new Set())
  if (!perCampHour.has(h)) perCampHour.set(h, new Set())
  perCampDay.get(d)!.add(sysOf(l.userId))
  perCampHour.get(h)!.add(sysOf(l.userId))
}
const dayCollide = [...perCampDay.entries()].filter(([, s]) => s.size > 1)
const hourCollide = [...perCampHour.entries()].filter(([, s]) => s.size > 1)
console.log(`  campaign-DAYS with two or more different systems writing: ${dayCollide.length} of ${perCampDay.size}`)
console.log(`  campaign-HOURS with two or more different systems writing: ${hourCollide.length} of ${perCampHour.size}`)
console.log(`  distinct campaigns involved in an hour-level collision: ${new Set(hourCollide.map(([k]) => k.split('|')[0])).size}`)
for (const [k, s] of hourCollide.slice(0, 8)) console.log(`    ${k}  ← ${[...s].join(' + ')}`)

// direction + magnitude
let inc = 0, dec = 0, same = 0
const readBudget = (p: unknown): number | null => {
  const o = p as Record<string, unknown> | null
  if (!o) return null
  const v = o.dailyBudget ?? o.budget ?? null
  return v == null ? null : Number(v)
}
for (const l of logs) {
  const b = readBudget(l.payloadBefore), a = readBudget(l.payloadAfter)
  if (b == null || a == null) { same++; continue }
  if (a > b) inc++; else if (a < b) dec++; else same++
}
console.log(`  direction: ${inc} increases · ${dec} decreases · ${same} no-change/unparsed`)
if (logs[0]) console.log(`  sample payloadBefore/After: ${JSON.stringify(logs[0].payloadBefore)} → ${JSON.stringify(logs[0].payloadAfter)}`)

await prisma.$disconnect()
