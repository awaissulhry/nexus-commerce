/**
 * SUB — substrate reconciliation. READ-ONLY: no writes, no mutations.
 *
 * Eleven page-studies each stated requirements on a shared layer. This measures the layer
 * itself, so the spec that reconciles them is built on numbers rather than on eleven
 * paraphrases of each other.
 *
 * Five questions:
 *   1. CADENCE — how often does anything actually change? (decides the sync mechanism)
 *   2. VISIBILITY — what fraction of those changes can the existing SSE bus see?
 *   3. FRESHNESS — is there one place that already knows how old each feed is?
 *   4. CEILINGS — which guardrail columns hold a value, per scope grain?
 *   5. QUEUE — the proposal queue's real shape and its status casing.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const ago = (d: Date | null | undefined) =>
  d ? `${((Date.now() - d.getTime()) / 86_400_000).toFixed(1)}d` : '—'

const now = new Date()
const d60 = new Date(now.getTime() - 60 * 86_400_000)
const d7 = new Date(now.getTime() - 7 * 86_400_000)
const d1 = new Date(now.getTime() - 86_400_000)
const h1 = new Date(now.getTime() - 3_600_000)

console.log('\n=== 1 · CADENCE — AdvertisingActionLog, the change ledger ===')
const logTotal = await prisma.advertisingActionLog.count()
const log60 = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: d60 } } })
const log7 = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: d7 } } })
const log1 = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: d1 } } })
const logH = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: h1 } } })
const oldest = await prisma.advertisingActionLog.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
const newest = await prisma.advertisingActionLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
console.log(`total ${int(logTotal)} · 60d ${int(log60)} · 7d ${int(log7)} · 24h ${int(log1)} · last hour ${int(logH)}`)
console.log(`oldest ${oldest?.createdAt.toISOString().slice(0, 16)} · newest ${newest?.createdAt.toISOString().slice(0, 16)} (${ago(newest?.createdAt)} ago)`)
console.log(`⇒ mean rate over 24h: ${(log1 / 24).toFixed(1)} writes/hour`)

const byType = await prisma.advertisingActionLog.groupBy({
  by: ['actionType'], where: { createdAt: { gte: d60 } }, _count: { _all: true },
})
console.log('\nby actionType (60d):')
for (const r of byType.sort((a, b) => b._count._all - a._count._all).slice(0, 14)) {
  console.log(`  ${pad(r.actionType, 34)} ${int(r._count._all).padStart(8)}`)
}

const byEntity = await prisma.advertisingActionLog.groupBy({
  by: ['entityType'], where: { createdAt: { gte: d60 } }, _count: { _all: true },
})
console.log('\nby entityType (60d):')
for (const r of byEntity.sort((a, b) => b._count._all - a._count._all)) {
  console.log(`  ${pad(r.entityType, 34)} ${int(r._count._all).padStart(8)}`)
}

console.log('\n=== 2 · VISIBILITY — what the execution-events SSE bus can see ===')
// The bus publishes ONLY automation.rule.fired, from automation-rule.service.ts.
const withExec = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: d60 }, executionId: { not: null } } })
const withUser = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: d60 }, executionId: null, userId: { not: null } } })
const neither = log60 - withExec - withUser
console.log(`60d writes ${int(log60)}`)
console.log(`  attributed to a rule EXECUTION (bus sees) ${int(withExec)}  ${((withExec / Math.max(1, log60)) * 100).toFixed(2)}%`)
console.log(`  attributed to a userId (bus blind)        ${int(withUser)}  ${((withUser / Math.max(1, log60)) * 100).toFixed(2)}%`)
console.log(`  neither — engine/system (bus blind)       ${int(neither)}  ${((neither / Math.max(1, log60)) * 100).toFixed(2)}%`)

const actors = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { createdAt: { gte: d60 } }, _count: { _all: true },
})
console.log('\ntop actors (userId, 60d):')
for (const r of actors.sort((a, b) => b._count._all - a._count._all).slice(0, 10)) {
  console.log(`  ${pad(String(r.userId ?? '(null)'), 40)} ${int(r._count._all).padStart(8)}`)
}

// Rule executions: does the bus fire at all, and how often?
const execTotal = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: d7 } } })
const execByStatus = await prisma.automationRuleExecution.groupBy({
  by: ['status'], where: { startedAt: { gte: d7 } }, _count: { _all: true },
})
console.log(`\nAutomationRuleExecution rows, 7d: ${int(execTotal)}  ⇒ ${(execTotal / (7 * 24 * 60)).toFixed(1)} events/minute on the bus`)
for (const r of execByStatus.sort((a, b) => b._count._all - a._count._all)) {
  console.log(`  ${pad(r.status, 20)} ${int(r._count._all).padStart(8)}`)
}

console.log('\n=== 3 · FRESHNESS — per-source recency, and whether a registry already knows ===')
const srcs: Array<[string, Date | null | undefined, number]> = []
const sqp = await prisma.searchQueryPerformance.findFirst({ orderBy: { startDate: 'desc' }, select: { startDate: true } })
const sqpN = await prisma.searchQueryPerformance.count()
srcs.push(['SearchQueryPerformance.startDate', sqp?.startDate, sqpN])
const st = await prisma.amazonAdsSearchTerm.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
const stN = await prisma.amazonAdsSearchTerm.count()
srcs.push(['AmazonAdsSearchTerm.date', st?.date, stN])
const dp = await prisma.amazonAdsDailyPerformance.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
const dpN = await prisma.amazonAdsDailyPerformance.count()
srcs.push(['AmazonAdsDailyPerformance.date', dp?.date, dpN])
try {
  const pl = await prisma.amazonAdsPlacementReport.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
  const plN = await prisma.amazonAdsPlacementReport.count()
  srcs.push(['AmazonAdsPlacementReport.date', pl?.date, plN])
  const plIS = await prisma.amazonAdsPlacementReport.findFirst({
    where: { topOfSearchIS: { not: null } }, orderBy: { date: 'desc' }, select: { date: true },
  })
  const plISN = await prisma.amazonAdsPlacementReport.count({ where: { topOfSearchIS: { not: null } } })
  srcs.push(['  …with topOfSearchIS', plIS?.date, plISN])
} catch (e) { console.log(`  (placement report: ${(e as Error).message.slice(0, 60)})`) }
for (const [label, d, n] of srcs) {
  console.log(`  ${pad(label, 36)} ${d ? d.toISOString().slice(0, 10) : '—'}  ${ago(d).padStart(7)}  rows ${int(n)}`)
}

const runs = await prisma.amazonReportRun.count()
const runsFresh = await prisma.amazonReportRun.count({ where: { freshAsOf: { not: null } } })
const runTypes = await prisma.amazonReportRun.groupBy({ by: ['reportType'], _count: { _all: true } })
console.log(`\nAmazonReportRun (the R0.1 freshness registry): ${int(runs)} rows, ${int(runsFresh)} with freshAsOf`)
for (const r of runTypes.sort((a, b) => b._count._all - a._count._all).slice(0, 12)) {
  console.log(`  ${pad(r.reportType, 46)} ${int(r._count._all).padStart(6)}`)
}

console.log('\n=== 4 · CEILINGS — which guardrail column holds a value, at which grain ===')
const camps = await prisma.campaign.count()
const cols: Array<[string, number]> = [
  ['liveBidWritesEnabled = true', await prisma.campaign.count({ where: { liveBidWritesEnabled: true } })],
  ['minBidCents set', await prisma.campaign.count({ where: { minBidCents: { not: null } } })],
  ['maxBidCents set', await prisma.campaign.count({ where: { maxBidCents: { not: null } } })],
  ['pinBids', await prisma.campaign.count({ where: { pinBids: true } })],
  ['pinPlacement', await prisma.campaign.count({ where: { pinPlacement: true } })],
  ['pinBudget', await prisma.campaign.count({ where: { pinBudget: true } })],
  ['portfolioId set', await prisma.campaign.count({ where: { portfolioId: { not: null } } })],
]
console.log(`Campaign rows: ${int(camps)}`)
for (const [label, n] of cols) console.log(`  ${pad(label, 30)} ${String(n).padStart(4)} / ${camps}  ${((n / camps) * 100).toFixed(0)}%`)

const st8 = await prisma.adsAutomationState.findFirst()
console.log(`\nAdsAutomationState (the ONLY spend guard, account-wide singleton):`)
console.log(`  autonomy=${st8?.autonomy} halted=${st8?.halted} maxHourlySpendCentsEur=${st8?.maxHourlySpendCentsEur ?? 'NULL'} maxActionsPerHour=${st8?.maxActionsPerHour ?? 'NULL'}`)

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { enabled: true, autonomyLevel: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true, maxExecutionsPerDay: true },
})
const scoped = (k: 'scopeMarketplace' | 'scopePortfolioId' | 'scopeCampaignId' | 'scopeProductId') => rules.filter((r) => r[k] != null).length
console.log(`\nAutomationRule (advertising): ${rules.length}`)
console.log(`  enabled ${rules.filter((r) => r.enabled).length} · AUTO ${rules.filter((r) => r.enabled && r.autonomyLevel === 'AUTO').length} · PROPOSE ${rules.filter((r) => r.enabled && r.autonomyLevel === 'PROPOSE').length}`)
console.log(`  scoped: market ${scoped('scopeMarketplace')} · portfolio ${scoped('scopePortfolioId')} · campaign ${scoped('scopeCampaignId')} · product ${scoped('scopeProductId')}`)
console.log(`  unscoped entirely: ${rules.filter((r) => !r.scopeMarketplace && !r.scopePortfolioId && !r.scopeCampaignId && !r.scopeProductId).length}`)
console.log(`  maxExecutionsPerDay set: ${rules.filter((r) => r.maxExecutionsPerDay != null).length}`)

console.log('\n=== 5 · QUEUE — AdsRuleSuggestion ===')
const sug = await prisma.adsRuleSuggestion.groupBy({ by: ['status'], _count: { _all: true } })
for (const r of sug.sort((a, b) => b._count._all - a._count._all)) console.log(`  status=${pad(String(r.status), 14)} ${int(r._count._all).padStart(6)}`)
const sOld = await prisma.adsRuleSuggestion.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
const sNew = await prisma.adsRuleSuggestion.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
console.log(`  oldest pending ${ago(sOld?.createdAt)} · newest pending ${ago(sNew?.createdAt)}`)

console.log('\n=== 6 · The objects the eleven pages are views of ===')
const counts: Array<[string, number]> = [
  ['RankScheduleGroup', await prisma.rankScheduleGroup.count()],
  ['RankTarget', await prisma.rankTarget.count()],
  ['ProductRankPlan', await prisma.productRankPlan.count()],
  ['BudgetSchedule', await prisma.budgetSchedule.count()],
  ['AdBudgetPlan', await prisma.adBudgetPlan.count()],
  ['KeywordCoverageSet', await prisma.keywordCoverageSet.count()],
  ['KeywordRank', await prisma.keywordRank.count()],
  ['AdKeywordProtection', await prisma.adKeywordProtection.count()],
]
for (const [k, n] of counts) console.log(`  ${pad(k, 26)} ${String(n).padStart(6)}`)

await prisma.$disconnect()
