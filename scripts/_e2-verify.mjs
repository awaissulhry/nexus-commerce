// E2 verification: row counts + freshness + samples across the new tables.
// Read-only. Run: node scripts/_e2-verify.mjs
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
const prisma = new PrismaClient()

console.log('════ campaigns ════')
const camps = await prisma.ebayCampaign.groupBy({ by: ['fundingModel', 'status'], _count: { _all: true } })
for (const c of camps) console.log(` ${c.fundingModel} ${c.status}: ${c._count._all}`)
const withCriterion = await prisma.ebayCampaign.count({ where: { isRulesBased: true } })
console.log(` rules-based: ${withCriterion}`)

console.log('════ entities ════')
console.log(' ads:', await prisma.ebayAd.count(), '| with rate:', await prisma.ebayAd.count({ where: { bidPercentage: { not: null } } }))
console.log(' adGroups:', await prisma.ebayAdGroup.count(), '| keywords:', await prisma.ebayKeyword.count(), '| negatives:', await prisma.ebayNegativeKeyword.count())
const rateSample = await prisma.ebayAd.findFirst({ where: { bidPercentage: { not: null } }, select: { listingId: true, bidPercentage: true, status: true } })
console.log(' sample ad:', JSON.stringify(rateSample))

console.log('════ report tasks ════')
const tasks = await prisma.ebayAdsReportTask.groupBy({ by: ['status'], _count: { _all: true }, _sum: { rowsIngested: true } })
for (const t of tasks) console.log(` ${t.status}: n=${t._count._all} rows=${t._sum.rowsIngested}`)

console.log('════ facts ════')
const facts = await prisma.ebayAdsDailyPerformance.groupBy({
  by: ['entityType', 'fundingModel'],
  _count: { _all: true },
  _sum: { impressions: true, clicks: true, adFeesCents: true, salesCents: true, soldQty: true },
})
for (const f of facts) {
  console.log(` ${f.entityType}/${f.fundingModel}: rows=${f._count._all} impr=${f._sum.impressions} clicks=${f._sum.clicks} fees=€${((f._sum.adFeesCents ?? 0) / 100).toFixed(2)} sales=€${((f._sum.salesCents ?? 0) / 100).toFixed(2)} sold=${f._sum.soldQty}`)
}
const span = await prisma.ebayAdsDailyPerformance.aggregate({ _min: { date: true }, _max: { date: true, reportedAt: true } })
console.log(` date span: ${span._min.date?.toISOString().slice(0, 10)} → ${span._max.date?.toISOString().slice(0, 10)} | freshest reportedAt: ${span._max.reportedAt?.toISOString()}`)

console.log('════ CampaignMetric rollup (cross-channel) ════')
const cm = await prisma.campaignMetric.aggregate({ where: { channel: 'EBAY' }, _count: { _all: true }, _sum: { costEurCents: true } })
console.log(` rows=${cm._count._all} cost=€${(Number(cm._sum.costEurCents ?? 0) / 100).toFixed(2)}`)

console.log('════ listing index ════')
const idx = await prisma.ebayListingIndex.groupBy({ by: ['matchStatus'], _count: { _all: true } })
for (const i of idx) console.log(` ${i.matchStatus}: ${i._count._all}`)
console.log(' live:', await prisma.ebayListingIndex.count({ where: { endedAt: null } }), '| with aspects:', await prisma.ebayListingIndex.count({ where: { aspects: { not: null } } }))

console.log('════ economics ════')
const eco = await prisma.ebayListingEconomics.groupBy({ by: ['dataStatus'], _count: { _all: true } })
for (const e of eco) console.log(` ${e.dataStatus}: ${e._count._all}`)

console.log('════ resolver (top matched product) ════')
const matched = await prisma.ebayListingIndex.findFirst({ where: { matchStatus: 'MATCHED' }, select: { productIds: true, itemId: true } })
if (matched?.productIds[0]) {
  const pid = matched.productIds[0]
  const idxRows = await prisma.ebayListingIndex.findMany({ where: { endedAt: null, productIds: { has: pid } }, select: { itemId: true, marketplace: true } })
  const mem = await prisma.sharedListingMembership.findMany({ where: { productId: pid, status: 'ACTIVE' }, select: { itemId: true } })
  const cls = await prisma.channelListing.findMany({ where: { productId: pid, channel: 'EBAY', listingStatus: 'ACTIVE', externalListingId: { not: null } }, select: { externalListingId: true } })
  const union = new Set([...idxRows.map(r => r.itemId), ...mem.map(r => r.itemId), ...cls.map(r => r.externalListingId)])
  console.log(` product …${pid.slice(-6)} → ${union.size} live itemId(s): ${[...union].join(', ')} (index=${idxRows.length} shared=${mem.length} channel=${cls.length})`)
}

await prisma.$disconnect()
