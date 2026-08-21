import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const id = 'cmt3byq3i00arl901dwu06y4u'
const r = await prisma.automationRule.findUnique({ where: { id }, select: { lastEvaluatedAt: true } })
const execs = await prisma.automationRuleExecution.count({ where: { ruleId: id } })
const sugg = await prisma.adsRuleSuggestion.count({ where: { ruleId: id } }).catch(() => -1)
const logs = await prisma.advertisingActionLog.count({ where: { userId: `automation:${id}` } })
console.log(`lastEvaluatedAt=${r?.lastEvaluatedAt?.toISOString() ?? 'never'} · executions=${execs} · suggestions=${sugg} · actionLogs=${logs}`)
await prisma.$disconnect()
