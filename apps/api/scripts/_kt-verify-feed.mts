import '../src/env.js'
import prisma from '../src/db.js'

const NOW = new Date()
const ageDays = (d: Date | null | undefined) => (d ? ((+NOW - +d) / 86400000).toFixed(2) : 'n/a')
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : 'null')

function J(label: string, v: unknown) { console.log(`\n@@ ${label}\n` + JSON.stringify(v, null, 2)) }

async function main() {
  console.log('NOW = ' + NOW.toISOString())

  // ── 1. sqp-ingest CronRun since 2026-08-10 (verbatim) ─────────────
  const sqpRunsSince = await prisma.cronRun.findMany({
    where: { jobName: 'sqp-ingest', startedAt: { gte: new Date('2026-08-10T00:00:00Z') } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, startedAt: true, finishedAt: true, status: true, errorMessage: true, outputSummary: true, triggeredBy: true },
  })
  J('1a. sqp-ingest runs since 2026-08-10 (VERBATIM)', sqpRunsSince.map(r => ({
    startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), status: r.status,
    durationSec: r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 1000) : null,
    outputSummary: r.outputSummary, errorMessage: r.errorMessage, triggeredBy: r.triggeredBy,
  })))

  const sqpAll = await prisma.cronRun.findMany({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, status: true } })
  const sqpTotal = sqpAll.length
  const sqpNonSuccess = sqpAll.filter(r => r.status !== 'SUCCESS').length
  J('1b. sqp-ingest totals', { totalRuns: sqpTotal, nonSuccess: sqpNonSuccess, first: iso(sqpAll[sqpAll.length - 1]?.startedAt), latest: iso(sqpAll[0]?.startedAt), latestStatus: sqpAll[0]?.status, latestAgeDays: ageDays(sqpAll[0]?.startedAt) })

  // last 14 for context
  const sqpLast14 = await prisma.cronRun.findMany({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 14, select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true } })
  J('1c. last 14 sqp-ingest runs', sqpLast14.map(r => ({ startedAt: iso(r.startedAt), status: r.status, durationSec: r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 1000) : null, outputSummary: r.outputSummary, errorMessage: r.errorMessage })))

  // ── 2. SearchQueryPerformance ─────────────────────────────────────
  const sqpRowCount = await prisma.searchQueryPerformance.count()
  const perMarket = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace'], _count: { _all: true }, _max: { startDate: true, ingestedAt: true } })
  const maxIngested = await prisma.searchQueryPerformance.aggregate({ _max: { ingestedAt: true, startDate: true } })
  J('2a. SearchQueryPerformance totals', {
    totalRows: sqpRowCount,
    maxStartDateOverall: iso(maxIngested._max.startDate),
    maxStartDateAgeDays: ageDays(maxIngested._max.startDate),
    maxIngestedAt: iso(maxIngested._max.ingestedAt),
    maxIngestedAtAgeDays: ageDays(maxIngested._max.ingestedAt),
  })
  J('2b. SQP per market', perMarket.map(m => ({ marketplace: m.marketplace, rows: m._count._all, latestStartDate: iso(m._max.startDate), latestIngestedAt: iso(m._max.ingestedAt) })))

  // distinct periods, last 12
  const periods: Array<{ startDate: Date; n: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT "startDate", COUNT(*)::bigint AS n FROM "SearchQueryPerformance" GROUP BY "startDate" ORDER BY "startDate" DESC LIMIT 12`)
  J('2c. distinct startDate periods (last 12)', periods.map(p => ({ startDate: iso(p.startDate), rows: Number(p.n) })))

  // rows per week per market, last 8 weeks
  const wk: Array<{ startDate: Date; marketplace: string; n: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT "startDate", "marketplace", COUNT(*)::bigint AS n FROM "SearchQueryPerformance"
     WHERE "startDate" >= (SELECT MAX("startDate") FROM "SearchQueryPerformance") - INTERVAL '56 days'
     GROUP BY 1,2 ORDER BY 1 DESC, 2 ASC`)
  const wkTable: Record<string, Record<string, number>> = {}
  for (const r of wk) {
    const k = r.startDate.toISOString().slice(0, 10)
    wkTable[k] ??= {}
    wkTable[k][r.marketplace] = Number(r.n)
  }
  J('2d. rows per week per market (last 8 weeks)', wkTable)

  // ingestedAt recency: anything ingested in the last 3 days?
  const recentIngests: Array<{ d: string; n: bigint; mx: Date }> = await prisma.$queryRawUnsafe(
    `SELECT to_char("ingestedAt"::date,'YYYY-MM-DD') AS d, COUNT(*)::bigint AS n, MAX("startDate") AS mx
     FROM "SearchQueryPerformance" GROUP BY 1 ORDER BY 1 DESC LIMIT 10`)
  J('2e. SQP ingestedAt by day (last 10 days with any ingest)', recentIngests.map(r => ({ ingestDay: r.d, rows: Number(r.n), maxStartDateThatDay: iso(r.mx) })))

  // ── 3. topOfSearchIS ──────────────────────────────────────────────
  const placTotal = await prisma.amazonAdsPlacementReport.count()
  const tosNonNull = await prisma.amazonAdsPlacementReport.count({ where: { topOfSearchIS: { not: null } } })
  const tosAgg = await prisma.amazonAdsPlacementReport.aggregate({ where: { topOfSearchIS: { not: null } }, _min: { date: true }, _max: { date: true } })
  const tosCampaigns: Array<{ n: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT "campaignId")::bigint AS n FROM "AmazonAdsPlacementReport" WHERE "topOfSearchIS" IS NOT NULL`)
  const allCampaigns: Array<{ n: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT "campaignId")::bigint AS n FROM "AmazonAdsPlacementReport"`)
  const tosByMkt: Array<{ marketplace: string; n: bigint; avg: number; mx: Date }> = await prisma.$queryRawUnsafe(
    `SELECT "marketplace", COUNT(*)::bigint AS n, AVG("topOfSearchIS")::float8 AS avg, MAX("date") AS mx
     FROM "AmazonAdsPlacementReport" WHERE "topOfSearchIS" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)
  const placMaxDate = await prisma.amazonAdsPlacementReport.aggregate({ _max: { date: true } })
  J('3a. topOfSearchIS', {
    placementRowsTotal: placTotal,
    topOfSearchISNonNull: tosNonNull,
    minDate: iso(tosAgg._min.date), maxDate: iso(tosAgg._max.date), maxDateAgeDays: ageDays(tosAgg._max.date),
    distinctCampaignsWithIS: Number(tosCampaigns[0].n), distinctCampaignsTotal: Number(allCampaigns[0].n),
    placementReportMaxDateAnyRow: iso(placMaxDate._max.date), placementMaxDateAgeDays: ageDays(placMaxDate._max.date),
  })
  J('3b. topOfSearchIS by market', tosByMkt.map(r => ({ marketplace: r.marketplace, rows: Number(r.n), avgPct: (r.avg * 100).toFixed(2), maxDate: iso(r.mx) })))

  const tosRuns = await prisma.cronRun.findMany({ where: { jobName: 'tos-is-ingest' }, orderBy: { startedAt: 'desc' }, take: 5, select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true } })
  const tosRunTotal = await prisma.cronRun.count({ where: { jobName: 'tos-is-ingest' } })
  J('3c. last 5 tos-is-ingest runs (VERBATIM) + total', { totalRuns: tosRunTotal, runs: tosRuns.map(r => ({ startedAt: iso(r.startedAt), status: r.status, durationSec: r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 1000) : null, outputSummary: r.outputSummary, errorMessage: r.errorMessage })) })

  // ── 4. other signals ──────────────────────────────────────────────
  const stMax = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true } })
  const stCount = await prisma.amazonAdsSearchTerm.count()
  const dpMax = await prisma.amazonAdsDailyPerformance.aggregate({ _max: { date: true } })
  const dpTargetMax = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'AD_TARGET' }, _max: { date: true } })
  const dpCount = await prisma.amazonAdsDailyPerformance.count()
  let krCount: number | string
  try { krCount = await prisma.keywordRank.count() } catch (e) { krCount = 'ERROR: ' + (e instanceof Error ? e.message : String(e)) }
  J('4. other signals', {
    AmazonAdsSearchTerm: { rows: stCount, maxDate: iso(stMax._max.date), ageDays: ageDays(stMax._max.date) },
    AmazonAdsDailyPerformance: { rows: dpCount, maxDate: iso(dpMax._max.date), ageDays: ageDays(dpMax._max.date), maxDateAD_TARGET: iso(dpTargetMax._max.date), ageDaysAD_TARGET: ageDays(dpTargetMax._max.date) },
    KeywordRank: krCount,
  })

  // ── 5. CRITICAL: the 9 markets, the 5 failures, and the 10 ASINs ──
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true, profileId: true } })
  const markets = [...new Set(conns.map(c => c.marketplace))]
  J('5a. active AmazonAdsConnection markets (exactly as the job derives them)', { count: markets.length, markets, connectionRows: conns.length })

  const perMktListings: Record<string, unknown> = {}
  for (const mkt of markets) {
    const listings = await prisma.channelListing.findMany({
      where: { channel: 'AMAZON', OR: [{ marketplace: mkt }, { region: mkt }] },
      select: { externalParentId: true, externalListingId: true, listingStatus: true },
      orderBy: { listingStatus: 'asc' },
      take: 1000,
    })
    // reproduce ourAsinsForMarketplace(mkt, 10) EXACTLY
    const asins: string[] = []
    const seen = new Set<string>()
    const ordered = [...listings].sort((a, b) => (a.listingStatus === 'ACTIVE' ? -1 : 1) - (b.listingStatus === 'ACTIVE' ? -1 : 1))
    for (const l of ordered) {
      const asin = l.externalParentId || l.externalListingId
      if (asin && !seen.has(asin)) { seen.add(asin); asins.push(asin) }
      if (asins.length >= 10) break
    }
    const statusCounts: Record<string, number> = {}
    for (const l of listings) statusCounts[l.listingStatus ?? 'null'] = (statusCounts[l.listingStatus ?? 'null'] ?? 0) + 1
    // also the total marketplace row count without the take(1000) cap
    const totalListings = await prisma.channelListing.count({ where: { channel: 'AMAZON', OR: [{ marketplace: mkt }, { region: mkt }] } })
    perMktListings[mkt] = {
      channelListingRows_total: totalListings,
      channelListingRows_fetched: listings.length,
      listingStatusCounts: statusCounts,
      asinsResolved: asins.length,
      asins,
      willThrowNoAsins: asins.length === 0,
    }
  }
  J('5b. ourAsinsForMarketplace(mkt, 10) reproduced per market', perMktListings)

  const failing = markets.filter(m => (perMktListings[m] as { asinsResolved: number }).asinsResolved === 0).sort()
  const passing = markets.filter(m => (perMktListings[m] as { asinsResolved: number }).asinsResolved > 0).sort()
  J('5c. verdict', {
    failingMarkets: failing, failingCount: failing.length,
    passingMarkets: passing, passingCount: passing.length,
    expectedFailing: ['IE', 'NL', 'PL', 'SE', 'UK'],
    matchesExpectedFailing: JSON.stringify(failing) === JSON.stringify(['IE', 'NL', 'PL', 'SE', 'UK']),
    allPassingResolveExactly10: passing.every(m => (perMktListings[m] as { asinsResolved: number }).asinsResolved === 10),
  })

  await prisma.$disconnect()
}

main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1) })
