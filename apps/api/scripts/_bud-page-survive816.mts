/**
 * BUD.8 §2.2 + §2.3 — what fired on 2026-08-05, and would a restore survive the next tick?
 *
 * §2.3 is the gate: `ad-budget-enforce` runs every 30 minutes. If it would re-floor a restored
 * campaign on its next tick, recovery is a tab 4 decision and this session must not attempt it.
 *
 * The decision hinges on ONE predicate (`ads-budget-enforce.service.ts:114`):
 *
 *   pacingNeeded = autoPacing && cap > 0 && projected > cap
 *   projected    = mtd + (mtd / daysElapsed) * remainingDays
 *
 * When false, `targetDailyCents` is null for every campaign, `deltaCents` is 0, and the engine
 * writes NOTHING. That predicate is the fix for the 2026-08-05 incident — the code comment above it
 * says pacing "may only act when the month is actually heading past" the cap, and names the day.
 *
 * This reconstructs the predicate from live data, and also reports the arming flags, because a
 * correct predicate on an engine running in apply mode is a different risk from one in dry-run.
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const now = new Date()
const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

console.log(`\n══ BUD.8 §2.3 — would a restore survive the next ad-budget-enforce tick? ══`)
console.log(`  month=${month}  now=${now.toISOString()}\n`)

// ── the arming flags ─────────────────────────────────────────────────────────────────────────
console.log(`── arming ──`)
console.log(`  NEXUS_BUDGET_ENFORCE_APPLY = ${process.env.NEXUS_BUDGET_ENFORCE_APPLY ?? '(unset)'}  ${process.env.NEXUS_BUDGET_ENFORCE_APPLY === '1' ? '🔴 LIVE — it writes' : '✓ dry-run — it computes and writes nothing'}`)
console.log(`  NEXUS_BUDGET_ENFORCE_SCHEDULE = ${process.env.NEXUS_BUDGET_ENFORCE_SCHEDULE ?? '*/30 * * * * (default)'}`)
console.log(`  NEXUS_ENABLE_AMAZON_ADS_CRON = ${process.env.NEXUS_ENABLE_AMAZON_ADS_CRON ?? '(unset)'}`)

// ── the plans, and the predicate ─────────────────────────────────────────────────────────────
const plans = await prisma.adBudgetPlan.findMany({
  where: { month, tag: null, OR: [{ autoPacing: true }, { stopOverSpend: true }] },
})
const allPlans = await prisma.adBudgetPlan.findMany({ where: { month, tag: null } })
console.log(`\n── AdBudgetPlan rows for ${month} ──`)
console.log(`  total: ${allPlans.length} · with autoPacing OR stopOverSpend: ${plans.length}`)
if (!plans.length) {
  console.log(`  🟢 NO PLAN IS ARMED — computeBudgetEnforcement iterates zero plans, so the engine`)
  console.log(`     cannot write a budget at all this month, whatever NEXUS_BUDGET_ENFORCE_APPLY says.`)
}
for (const p of allPlans) {
  console.log(`  ${pad(p.marketplace, 4)} cap=${pad(eur(p.monthlyBudgetCents ?? 0), 11)} autoPacing=${p.autoPacing ? 'ON ' : 'off'} stopOverSpend=${p.stopOverSpend ? 'ON ' : 'off'}`)
}

// ── reconstruct the predicate per market ─────────────────────────────────────────────────────
const dayOfMonth = now.getUTCDate()
const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
const remainingDays = Math.max(1, daysInMonth - dayOfMonth + 1)
const daysElapsed = Math.max(1, dayOfMonth)
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

console.log(`\n── the predicate, reconstructed (day ${dayOfMonth} of ${daysInMonth}, ${remainingDays} remaining) ──`)
console.log(`  ${pad('market', 7)} ${pad('cap', 11)} ${pad('MTD spend', 11)} ${pad('projected', 11)} pacingNeeded?`)
for (const p of allPlans) {
  const camps = await prisma.campaign.findMany({ where: { marketplace: p.marketplace, status: 'ENABLED' }, select: { id: true } })
  const perf = camps.length ? await prisma.amazonAdsDailyPerformance.aggregate({
    where: { entityType: 'CAMPAIGN', localEntityId: { in: camps.map((c) => c.id) }, date: { gte: monthStart } },
    _sum: { costMicros: true },
  }) : null
  const mtd = perf?._sum.costMicros != null ? Math.round(Number(perf._sum.costMicros) / 10_000) : 0
  const cap = p.monthlyBudgetCents ?? 0
  const projected = cap > 0 ? Math.round(mtd + (mtd / daysElapsed) * remainingDays) : 0
  const needed = p.autoPacing && cap > 0 && projected > cap
  const headroom = cap > 0 ? ((cap - projected) / cap) * 100 : 0
  console.log(`  ${pad(p.marketplace, 7)} ${pad(eur(cap), 11)} ${pad(eur(mtd), 11)} ${pad(eur(projected), 11)} ${needed ? '🔴 YES — it would rewrite budgets' : `✓ no (${headroom.toFixed(0)}% under)`}`)
}

// ── what the engine has actually done lately ─────────────────────────────────────────────────
const since7 = new Date(+now - 7 * 86_400_000)
const recent = await prisma.advertisingActionLog.count({
  where: { actionType: 'AD_BUDGET_UPDATE', userId: { contains: 'budget-manager' }, createdAt: { gte: since7 } },
})
const newest = await prisma.advertisingActionLog.findFirst({
  where: { actionType: 'AD_BUDGET_UPDATE' }, orderBy: { createdAt: 'desc' },
  select: { createdAt: true, userId: true },
})
console.log(`\n── what it has actually written ──`)
console.log(`  budget-manager writes in the last 7 days : ${recent}`)
console.log(`  newest AD_BUDGET_UPDATE of any author    : ${newest?.createdAt.toISOString() ?? 'none'} by ${newest?.userId ?? '—'}`)

// ── the cron's own record ────────────────────────────────────────────────────────────────────
const runs = await prisma.cronRun.findMany({
  where: { name: 'ad-budget-enforce' }, orderBy: { startedAt: 'desc' }, take: 5,
  select: { startedAt: true, status: true, detail: true },
}).catch(() => [] as Array<{ startedAt: Date; status: string; detail: string | null }>)
console.log(`\n── ad-budget-enforce, last 5 runs ──`)
if (!runs.length) console.log(`  (no CronRun rows — the table may be named differently; not a finding on its own)`)
for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${pad(r.status, 9)} ${r.detail ?? ''}`)

await prisma.$disconnect()
