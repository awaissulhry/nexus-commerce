import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true } })
console.log(`advertising rules: ${rules.length}`); for (const r of rules) console.log(`  "${r.name}" ${r.enabled} ${r.autonomyLevel} ${r.trigger}`)
const [assign, enabled, floor1, baselines, minSet, maxSet] = await Promise.all([
  prisma.campaignRuleAssignment.count().catch(() => -1),
  prisma.campaign.count({ where: { status: 'ENABLED' } }),
  prisma.campaign.count({ where: { status: 'ENABLED', dailyBudget: { lte: 1 } } }),
  prisma.campaign.count({ where: { budgetBaselineCents: { not: null } } }),
  prisma.campaign.count({ where: { minBudgetCents: { not: null, gt: 0 } } }).catch(() => -1),
  prisma.campaign.count({ where: { maxBudgetCents: { not: null, gt: 0 } } }).catch(() => -1),
])
console.log(`assignments: ${assign} · enabled campaigns: ${enabled} · at €1 floor: ${floor1} · baselines: ${baselines} · min set: ${minSet} · max set: ${maxSet}`)
// budget writes last 7d + campaigns with spend in the 7d settled window (the context floor)
const since = new Date(Date.now() - 9 * 864e5); const until = new Date(Date.now() - 2 * 864e5)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', date: { gte: since, lte: until } }, _sum: { costMicros: true } })
const spending = perf.filter((p) => Number(p._sum.costMicros ?? 0) > 0).length
const writes7d = await prisma.advertisingActionLog.count({ where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: new Date(Date.now() - 7 * 864e5) } } }).catch(() => -1)
console.log(`campaigns with spend in the 7d settled window (context floor): ${spending} · AD_BUDGET_UPDATE rows 7d: ${writes7d}`)
await prisma.$disconnect()
