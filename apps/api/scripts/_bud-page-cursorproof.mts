/**
 * BUD.1 — the cursor, sampled twice 60 s apart.
 *
 * Bid's load-bearing cursor field is `max(AdTarget.updatedAt)`. The equivalent here would be
 * `max(Campaign.updatedAt)` — and it does not work: 219 of 220 campaigns changed in the last six
 * hours while exactly ONE had a budget write in 24 h. A cursor built on it reports "changed" on
 * every poll, which is a permanently-lit banner and therefore no banner at all.
 *
 * So the fingerprint is the VALUE: sum(Campaign.dailyBudget) over the scope, in cents. This script
 * samples both, 60 s apart, and shows which one discriminates.
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const sample = async () => {
  const [agg, log, campNewest, exec] = await Promise.all([
    prisma.campaign.aggregate({ where: { status: 'ENABLED' }, _sum: { dailyBudget: true }, _count: { _all: true } }),
    prisma.advertisingActionLog.findFirst({ where: { actionType: 'AD_BUDGET_UPDATE' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.campaign.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    prisma.automationRuleExecution.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
  ])
  return {
    budgetCents: Math.round(Number(agg._sum.dailyBudget ?? 0) * 100),
    n: agg._count._all,
    loggedAt: log?.createdAt?.toISOString() ?? null,
    campaignsAt: campNewest?.updatedAt?.toISOString() ?? null,   // the field Bid uses; measured here to REJECT it
    execAt: exec?.startedAt?.toISOString() ?? null,
    campsTouched60s: 0,
  }
}

const t0 = new Date()
const a = await sample()
console.log(`\n── sample A · ${t0.toISOString()} ──`)
console.log(JSON.stringify(a, null, 1))

console.log(`\n  …waiting 60 s…`)
await new Promise((r) => setTimeout(r, 60_000))

const b = await sample()
b.campsTouched60s = await prisma.campaign.count({ where: { updatedAt: { gte: t0 } } })
console.log(`\n── sample B · ${new Date().toISOString()} ──`)
console.log(JSON.stringify(b, null, 1))

const moved = (k: keyof typeof a) => (a[k] === b[k] ? 'stable' : `MOVED  ${String(a[k])} → ${String(b[k])}`)
console.log(`\n── which fields discriminate? ──`)
console.log(`  budgetCents  (proposed, load-bearing) : ${moved('budgetCents')}`)
console.log(`  n            (proposed)               : ${moved('n')}`)
console.log(`  loggedAt     (proposed)               : ${moved('loggedAt')}`)
console.log(`  campaignsAt  (Bid's field — REJECTED) : ${moved('campaignsAt')}`)
console.log(`  execAt       (rules view only)        : ${moved('execAt')}`)
console.log(`\n  campaigns whose row changed during those 60 s : ${b.campsTouched60s} of ${b.n}`)
console.log(`  budget writes during those 60 s               : ${a.loggedAt === b.loggedAt ? 0 : '≥1'}`)
console.log(`\n  → a cursor containing campaignsAt would have gone stale ${a.campaignsAt === b.campaignsAt ? 'NOT at all in this window' : 'in 60 s with no budget change'}`)

await prisma.$disconnect()
