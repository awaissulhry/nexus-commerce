/** AUTO.P0 — has the evaluator ticked since the deploy, and did any rule hit a cap in that tick? */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const DEPLOY = new Date('2026-08-15T23:20:35.000Z')
const since = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: DEPLOY } } })
const newest = await prisma.automationRuleExecution.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true, ruleId: true, status: true } })
console.log(`\n   executions since deploy (${DEPLOY.toISOString()}): ${since}`)
console.log(`   newest execution row                        : ${newest?.startedAt.toISOString()} [${newest?.status}]`)
// Which rules ran since the deploy, and were any already at their cap when they did?
const rows = await prisma.$queryRawUnsafe<Array<{ name: string; cap: number | null; used: bigint; sinceDeploy: bigint }>>(`
  SELECT r.name, r."maxExecutionsPerDay" AS cap,
         COUNT(*) FILTER (WHERE e."startedAt" >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS used,
         COUNT(*) FILTER (WHERE e."startedAt" >= $1) AS "sinceDeploy"
  FROM "AutomationRuleExecution" e JOIN "AutomationRule" r ON r.id = e."ruleId"
  WHERE e."startedAt" >= date_trunc('day', now() AT TIME ZONE 'UTC')
    AND (e."errorMessage" IS NULL OR e."errorMessage" <> 'DAILY_CAP_EXCEEDED')
  GROUP BY 1,2 ORDER BY 4 DESC LIMIT 12
`, DEPLOY)
console.log(`\n   ${'rule'.padEnd(43)} ${'cap'.padStart(5)} ${'used today'.padStart(10)} ${'since deploy'.padStart(12)}`)
for (const r of rows) {
  console.log(`   ${r.name.slice(0,42).padEnd(43)} ${String(r.cap ?? '—').padStart(5)} ${String(r.used).padStart(10)} ${String(r.sinceDeploy).padStart(12)}`)
}
console.log('\n   A rule at its cap that ran 0 times since the deploy has not been ASKED yet —')
console.log('   the evaluator must tick and its conditions must match for a refusal to exist.')
await prisma.$disconnect()
