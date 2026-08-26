/**
 * SOV page study — part C. READ-ONLY.
 *
 * The tab's denominator is `totalImpressions` = every impression in AmazonAdsSearchTerm over 30d.
 * Part B showed that table carries only CLICKED queries (3 zero-click rows in 10,826). Part A
 * measured its 30d total at 498,606. So: what fraction of our REAL ad impressions is that?
 *
 * Compared against two independent tables over the identical window:
 *   · AmazonAdsPlacementReport  (campaign × day × placement — includes Product Pages)
 *   · AmazonAdsDailyPerformance (campaign-day)
 *
 * If the SOV denominator is a small slice, then "share of our own ad traffic" is not even true —
 * it is a share of our own CLICKED SEARCH traffic, and the honest column name has to say so.
 *
 * No writes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const p2 = (f: number) => `${(f * 100).toFixed(2)}%`

console.log('\n═══ SOV page study — C: what the denominator really covers ═══\n')

const since = new Date(Date.now() - 30 * 86_400_000)

const st = await prisma.amazonAdsSearchTerm.aggregate({ where: { date: { gte: since } }, _sum: { impressions: true, clicks: true }, _count: { _all: true } })
console.log(`AmazonAdsSearchTerm  (the SOV denominator)   rows ${int(st._count._all)}  impressions ${int(st._sum.impressions ?? 0)}  clicks ${int(st._sum.clicks ?? 0)}`)

const pl = await prisma.amazonAdsPlacementReport.aggregate({ where: { date: { gte: since } }, _sum: { impressions: true, clicks: true }, _count: { _all: true } })
console.log(`AmazonAdsPlacementReport                     rows ${int(pl._count._all)}  impressions ${int(pl._sum.impressions ?? 0)}  clicks ${int(pl._sum.clicks ?? 0)}`)

const plByPlacement = await prisma.amazonAdsPlacementReport.groupBy({ by: ['placement'], where: { date: { gte: since } }, _sum: { impressions: true, clicks: true } })
console.log(`\n  placement split over the same 30 days:`)
for (const p of plByPlacement.sort((a, b) => (b._sum.impressions ?? 0) - (a._sum.impressions ?? 0))) {
  console.log(`  ${pad(p.placement, 28)} ${pad(int(p._sum.impressions ?? 0), 12)} impressions · ${int(p._sum.clicks ?? 0)} clicks`)
}

const dp = await prisma.amazonAdsDailyPerformance.aggregate({ where: { date: { gte: since } }, _sum: { impressions: true, clicks: true }, _count: { _all: true } })
console.log(`\nAmazonAdsDailyPerformance (all entityTypes)  rows ${int(dp._count._all)}  impressions ${int(dp._sum.impressions ?? 0)}  clicks ${int(dp._sum.clicks ?? 0)}`)
const dpByEntity = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['entityType'], where: { date: { gte: since } }, _sum: { impressions: true, clicks: true } })
for (const e of dpByEntity.sort((a, b) => (b._sum.impressions ?? 0) - (a._sum.impressions ?? 0))) {
  console.log(`  ${pad(e.entityType, 16)} ${pad(int(e._sum.impressions ?? 0), 12)} impressions · ${int(e._sum.clicks ?? 0)} clicks`)
}

const campaignImpr = dpByEntity.find((e) => e.entityType === 'CAMPAIGN')?._sum.impressions ?? 0
const sovImpr = st._sum.impressions ?? 0
const plImpr = pl._sum.impressions ?? 0
console.log(`\n── the verdict ──`)
if (plImpr > 0) console.log(`SOV denominator ÷ placement-report impressions : ${int(sovImpr)} / ${int(plImpr)} = ${p2(sovImpr / plImpr)}`)
if (campaignImpr > 0) console.log(`SOV denominator ÷ campaign-grain impressions   : ${int(sovImpr)} / ${int(campaignImpr)} = ${p2(sovImpr / campaignImpr)}`)
console.log(`  → the column labelled "Share of Voice" divides by this number. It is neither the market's`)
console.log(`    impressions nor even all of ours.`)

// Clicks are the one quantity that SHOULD reconcile, since the search-term report is click-driven.
const stClicks = st._sum.clicks ?? 0
const plClicks = pl._sum.clicks ?? 0
if (plClicks > 0) console.log(`\nclicks reconcile better: search-term ${int(stClicks)} vs placement ${int(plClicks)} = ${p2(stClicks / plClicks)}`)
console.log(`  (Product Pages placement is not search, so it can never appear in a search-term report —`)
console.log(`   part of the gap is structural, not a data defect. Both parts still break the label.)`)

// Freshness of the ad side, for the page's own staleness banner.
const stLatest = await prisma.amazonAdsSearchTerm.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
const plLatest = await prisma.amazonAdsPlacementReport.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
const now = Date.now()
console.log(`\n── freshness of each source the page would render ──`)
console.log(`  AmazonAdsSearchTerm     latest date ${stLatest?.date.toISOString().slice(0, 10) ?? '—'}  age ${stLatest ? Math.round((now - +stLatest.date) / 86_400_000) : '—'}d`)
console.log(`  AmazonAdsPlacementReport latest date ${plLatest?.date.toISOString().slice(0, 10) ?? '—'}  age ${plLatest ? Math.round((now - +plLatest.date) / 86_400_000) : '—'}d`)

await prisma.$disconnect()
console.log('\n═══ end C ═══\n')
