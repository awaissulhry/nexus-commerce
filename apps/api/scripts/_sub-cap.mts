/** SUB — verify the daily-cap claim independently. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const d7 = new Date(Date.now() - 7 * 86400000)
const d60 = new Date(Date.now() - 60 * 86400000)

const capAll = await prisma.automationRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED' } })
const cap60 = await prisma.automationRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED', startedAt: { gte: d60 } } })
const cap7 = await prisma.automationRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED', startedAt: { gte: d7 } } })
const newest = await prisma.automationRuleExecution.findFirst({ where: { errorMessage: 'DAILY_CAP_EXCEEDED' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } })
console.log(`DAILY_CAP_EXCEEDED rows: all-time ${capAll.toLocaleString()} · 60d ${cap60.toLocaleString()} · 7d ${cap7.toLocaleString()}`)
console.log(`newest cap row: ${newest?.startedAt.toISOString().slice(0,16) ?? 'none'}`)

// The two filter forms, side by side, on one real rule.
const rule = await prisma.automationRule.findFirst({ where: { domain: 'advertising', enabled: true, maxExecutionsPerDay: { not: null } }, select: { id: true, name: true, maxExecutionsPerDay: true } })
const since = new Date(); since.setUTCHours(0,0,0,0)
if (rule) {
  const buggy = await prisma.automationRuleExecution.count({ where: { ruleId: rule.id, startedAt: { gte: since }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } })
  const correct = await prisma.automationRuleExecution.count({ where: { ruleId: rule.id, startedAt: { gte: since }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] } })
  const raw = await prisma.automationRuleExecution.count({ where: { ruleId: rule.id, startedAt: { gte: since } } })
  console.log(`\nrule "${rule.name}" cap=${rule.maxExecutionsPerDay}/day, today (UTC):`)
  console.log(`  counter as written  (NOT:{errorMessage}) → ${buggy}`)
  console.log(`  counter with null branch spelled out     → ${correct}`)
  console.log(`  rows actually written today              → ${raw}`)
}
await prisma.$disconnect()
