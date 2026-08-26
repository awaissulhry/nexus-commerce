/**
 * BUD page — is the maxExecutionsPerDay cap actually bounding anything?
 * automation-rule.service.ts:566 counts today's executions with
 *   NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' }
 * In SQL, NOT (col = 'x') is NULL — not TRUE — when col IS NULL. If Prisma emits that
 * literally, every SUCCESS row (errorMessage NULL) is excluded from the count and the cap
 * never trips. Measure it both ways. READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, maxExecutionsPerDay: true, actions: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const budget = rules.filter((r) => types(r.actions).some((t) => t === 'adjust_ad_budget'))

console.log(`\n── the cap, today (since ${dayStart.toISOString()}) ──`)
console.log(`${pad('rule', 42)} ${pad('cap', 5)} ${pad('asWritten', 10)} ${pad('allRows', 8)} ${pad('nullErr', 8)} tripped?`)
for (const r of budget) {
  // exactly the production predicate
  const asWritten = await prisma.automationRuleExecution.count({
    where: { ruleId: r.id, startedAt: { gte: dayStart }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } },
  })
  const allRows = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart } } })
  const nullErr = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart }, errorMessage: null } })
  const cap = r.maxExecutionsPerDay
  console.log(`${pad(r.name, 42)} ${pad(String(cap ?? '—'), 5)} ${pad(String(asWritten), 10)} ${pad(String(allRows), 8)} ${pad(String(nullErr), 8)} ${cap != null && asWritten >= cap ? 'YES' : '🔴 NO — cap is open'}`)
}

// the raw SQL Prisma emits for that predicate, checked directly
const [a] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT COUNT(*)::bigint AS n FROM "AutomationRuleExecution" WHERE "ruleId" = $1 AND "startedAt" >= $2 AND NOT ("errorMessage" = 'DAILY_CAP_EXCEEDED')`,
  budget[0]?.id ?? '', dayStart,
)
const [b] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT COUNT(*)::bigint AS n FROM "AutomationRuleExecution" WHERE "ruleId" = $1 AND "startedAt" >= $2 AND ("errorMessage" IS DISTINCT FROM 'DAILY_CAP_EXCEEDED')`,
  budget[0]?.id ?? '', dayStart,
)
console.log(`\n  raw SQL on ${budget[0]?.name}:  NOT (col = 'X') → ${a?.n}   ·   col IS DISTINCT FROM 'X' → ${b?.n}`)

// how many DAILY_CAP refusals happened today vs historically?
for (const r of budget.filter((x) => x.maxExecutionsPerDay != null)) {
  const today = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart }, errorMessage: 'DAILY_CAP_EXCEEDED' } })
  const ever = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, errorMessage: 'DAILY_CAP_EXCEEDED' } })
  const lastCap = await prisma.automationRuleExecution.findFirst({ where: { ruleId: r.id, errorMessage: 'DAILY_CAP_EXCEEDED' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } })
  console.log(`  ${pad(r.name, 42)} DAILY_CAP today=${pad(String(today), 5)} ever=${pad(String(ever), 7)} last=${lastCap?.startedAt.toISOString().slice(0, 16) ?? 'never'}`)
}

// and: how many writes did the ratchet fit into one day, against a 5/day cap?
const day = await prisma.advertisingActionLog.groupBy({
  by: ['userId'],
  where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: new Date('2026-08-09T00:00:00Z'), lt: new Date('2026-08-11T00:00:00Z') } },
  _count: { _all: true },
})
console.log(`\n  budget writes 2026-08-09 → 08-10, by actor:`)
for (const d of day.sort((x, y) => y._count._all - x._count._all)) console.log(`     ${pad(String(d.userId), 46)} ${d._count._all}`)

await prisma.$disconnect()
