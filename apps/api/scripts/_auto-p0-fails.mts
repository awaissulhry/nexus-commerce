/** AUTO.P0 — what the 827 REAL failures are. READ-ONLY. Refusals must never share a count with these. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRawUnsafe<Array<{ name: string; msg: string; c: bigint }>>(`
  SELECT r.name, COALESCE(e."errorMessage", '(null errorMessage)') AS msg, COUNT(*) AS c
  FROM "AutomationRuleExecution" e JOIN "AutomationRule" r ON r.id = e."ruleId"
  WHERE e."status" = 'FAILED'
    AND (e."errorMessage" IS NULL OR e."errorMessage" <> 'DAILY_CAP_EXCEEDED')
    AND e."startedAt" >= now() - interval '8 days'
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15
`)
console.log('\n═══ real FAILED executions, 8 days (cap refusals excluded, null branch spelled out) ═══')
for (const r of rows) console.log(`   ${String(r.c).padStart(5)}  ${r.name.slice(0,42).padEnd(43)} ${r.msg.slice(0,80)}`)
const sample = await prisma.automationRuleExecution.findFirst({
  where: { status: 'FAILED', OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }], startedAt: { gte: new Date(Date.now() - 8*86400000) } },
  orderBy: { startedAt: 'desc' }, select: { actionResults: true, errorMessage: true },
})
console.log('\n   newest one, verbatim:'); console.log(JSON.stringify(sample, null, 2).slice(0, 900))
await prisma.$disconnect()
