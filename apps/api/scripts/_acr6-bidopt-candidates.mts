/** ACR.6 — is the bid optimiser inert because there is nothing to do, or because a filter is wrong? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const step = async (label: string, where: Record<string, unknown>) => {
  const n = await prisma.adTarget.count({ where })
  console.log(`  ${label.padEnd(52)} ${String(n).padStart(7)}`)
  return n
}

console.log('\nAdTarget funnel, as previewBidOptimization filters it:')
await step('all AdTargets', {})
await step('… status=ENABLED', { status: 'ENABLED' })
await step('… + isNegative=false', { status: 'ENABLED', isNegative: false })
const withSpend = await step('… + spendCents > 0   ← the query it runs', { status: 'ENABLED', isNegative: false, spendCents: { gt: 0 } })
await step('… + clicks >= 5      ← MIN_CLICKS gate', { status: 'ENABLED', isNegative: false, spendCents: { gt: 0 }, clicks: { gte: 5 } })

// The service takes only the first 2000; irrelevant unless withSpend is large.
console.log(`\n  (the query takes at most 2000; candidates with spend = ${withSpend})`)

// Where does spend actually live? If AdTarget.spendCents is all zero the optimiser can never see it.
const agg = await prisma.adTarget.aggregate({ _sum: { spendCents: true, clicks: true, salesCents: true }, _count: true })
console.log(`\nAdTarget totals: rows=${agg._count} spend=${agg._sum.spendCents ?? 0}c clicks=${agg._sum.clicks ?? 0} sales=${agg._sum.salesCents ?? 0}c`)

// Where the spend demonstrably IS, so "no data" can be told apart from "data in another table".
const daily = await prisma.amazonAdsDailyPerformance.aggregate({ _sum: { costCents: true, clicks: true }, _count: true }).catch(() => null)
if (daily) console.log(`AmazonAdsDailyPerformance: rows=${daily._count} cost=${daily._sum.costCents ?? 0}c clicks=${daily._sum.clicks ?? 0}`)
const st = await prisma.amazonAdsSearchTerm.aggregate({ _sum: { costCents: true, clicks: true }, _count: true }).catch(() => null)
if (st) console.log(`AmazonAdsSearchTerm:       rows=${st._count} cost=${st._sum.costCents ?? 0}c clicks=${st._sum.clicks ?? 0}`)
const agc = await prisma.adGroup.aggregate({ _sum: { spendCents: true }, _count: true }).catch(() => null)
if (agc) console.log(`AdGroup:                   rows=${agc._count} spend=${agc._sum.spendCents ?? 0}c`)

const top = await prisma.adTarget.findMany({
  where: { spendCents: { gt: 0 } }, orderBy: { spendCents: 'desc' }, take: 5,
  select: { expressionValue: true, bidCents: true, spendCents: true, clicks: true, ordersCount: true, salesCents: true },
})
console.log('\ntop AdTargets by spend:')
for (const t of top) console.log(`  ${String(t.expressionValue).slice(0, 34).padEnd(36)} bid=${t.bidCents}c spend=${t.spendCents}c clicks=${t.clicks} orders=${t.ordersCount ?? 0} sales=${t.salesCents}c`)

await prisma.$disconnect()
