/**
 * AUTO page study — is `maxExecutionsPerDay` enforced at all? READ-ONLY.
 *
 * `automation-rule.service.ts:568` counts today's executions with:
 *     NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' }
 * which is the three-valued-logic trap this codebase has documented in three other places:
 * NOT (errorMessage = 'X') is NULL — not TRUE — for the null errorMessage every SUCCESS and
 * DRY_RUN row carries, so those rows are dropped from the count.
 *
 * If that is what is happening, `todayCount` sees only real failures, never reaches the cap,
 * and the cap never trips. This runs BOTH filter forms side by side and compares.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, maxExecutionsPerDay: true, autonomyLevel: true },
})

// Yesterday, a complete UTC day, so the comparison is not a partial-day artefact.
const dayStart = new Date(Date.now() - 86_400_000); dayStart.setUTCHours(0, 0, 0, 0)
const dayEnd = new Date(dayStart.getTime() + 86_400_000)
console.log(`\n═══ The cap counter, both ways, for ${dayStart.toISOString().slice(0, 10)} ═══\n`)
console.log(`${pad('rule', 46)} ${pad('cap', 5)} ${pad('service sees', 13)} ${pad('really ran', 11)} tripped?`)

for (const r of rules) {
  if (r.maxExecutionsPerDay == null) continue
  const [serviceSees, reallyRan, statuses] = await Promise.all([
    // EXACTLY the filter the service uses.
    prisma.automationRuleExecution.count({
      where: { ruleId: r.id, startedAt: { gte: dayStart, lt: dayEnd }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } },
    }),
    // The same intent, with the null branch spelled out.
    prisma.automationRuleExecution.count({
      where: {
        ruleId: r.id, startedAt: { gte: dayStart, lt: dayEnd },
        OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }],
      },
    }),
    prisma.automationRuleExecution.groupBy({
      by: ['status'], where: { ruleId: r.id, startedAt: { gte: dayStart, lt: dayEnd } }, _count: { _all: true },
    }),
  ])
  if (reallyRan === 0) continue
  const wouldTrip = reallyRan >= r.maxExecutionsPerDay
  const doesTrip = serviceSees >= r.maxExecutionsPerDay
  console.log(
    `   ${pad(r.name, 46)} ${pad(String(r.maxExecutionsPerDay), 5)} ${pad(String(serviceSees), 13)} ${pad(String(reallyRan), 11)}`
    + ` ${doesTrip ? 'YES' : wouldTrip ? '🔴 NO — should have' : 'n/a'}`
    + `   [${statuses.map((s) => `${s.status} ${s._count._all}`).join(' ')}]`,
  )
}

console.log('\nIf "service sees" is 0 while "really ran" is in the hundreds, the cap counted only')
console.log('rows with a NON-NULL errorMessage — i.e. real failures — and never reached the cap.')

await prisma.$disconnect()
