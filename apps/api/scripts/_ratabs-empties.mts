/**
 * RA.TABS — the four surviving tabs' data, so their empty states can state a FACT.
 * READ-ONLY: counts only.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const [budgetSchedules, keywordRanks, protections, rankGroups, rankGroupsEnabled, campaigns, sovRows] = await Promise.all([
  prisma.budgetSchedule.count(),
  prisma.keywordRank.count(),
  prisma.adKeywordProtection.count(),
  prisma.rankScheduleGroup.count(),
  prisma.rankScheduleGroup.count({ where: { enabled: true } }),
  prisma.campaign.count({ where: { channel: 'AMAZON' } }).catch(() => -1),
  // Share of Voice is derived from search-term rows, not a table of its own.
  prisma.amazonAdsSearchTerm.count().catch(() => -1),
])

console.log(`
BudgetSchedule rows        : ${budgetSchedules}
KeywordRank rows           : ${keywordRanks}
AdKeywordProtection rows   : ${protections}
RankScheduleGroup rows     : ${rankGroups} (${rankGroupsEnabled} enabled)
AdCampaign rows            : ${campaigns}
AdSearchTermDaily rows     : ${sovRows === -1 ? 'model not found' : sovRows}
`)

const byMode = await prisma.adKeywordProtection.groupBy({ by: ['mode'], _count: { _all: true } })
for (const g of byMode) console.log(`  protection ${g.mode}: ${g._count._all}`)

// Does the "Hourly Campaign Performance" card on Budget Schedules have data it is not showing?
// The tab hard-codes "Hourly data is not available for this marketplace" and never calls
// GET /advertising/budget-schedules/hourly-performance, which reads this table.
const hourly = await prisma.amazonAdsHourlyPerformance.count().catch(() => -1)
console.log(`\nAmazonAdsHourlyPerformance rows: ${hourly}`)

await prisma.$disconnect()
