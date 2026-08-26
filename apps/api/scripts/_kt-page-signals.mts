/**
 * _kt-page-signals.mts — what visibility signals this account actually holds, per keyword (read-only).
 *
 * The Keyword Tracker's four columns are Search Volume · Organic Rank · Sponsored Rank · Rank Δ.
 * Three of them describe something Amazon does not sell. This measures the honest substitutes we
 * DO hold, at the grain we hold them, so the page can be designed against real coverage:
 *   · SQP market volume + market rank + our impression/click/purchase share  (query × ASIN × week)
 *   · topOfSearchIS from the placement report                                (campaign × day)
 *   · our paid impressions/clicks/spend                                      (query × campaign × day)
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-page-signals.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)

async function main() {
  // ── A · topOfSearchIS: is Amazon's own paid-visibility metric real yet? ──
  h('A · AmazonAdsPlacementReport.topOfSearchIS')
  const plTotal = await prisma.amazonAdsPlacementReport.count()
  const plWithIs = await prisma.amazonAdsPlacementReport.count({ where: { topOfSearchIS: { not: null } } })
  line(`placement rows: ${plTotal}   with topOfSearchIS: ${plWithIs}`)
  const isRange = await prisma.amazonAdsPlacementReport.aggregate({
    where: { topOfSearchIS: { not: null } },
    _min: { date: true }, _max: { date: true }, _avg: { topOfSearchIS: true },
  })
  line(`topOfSearchIS date range: ${isRange._min.date ? d10(isRange._min.date) : '—'} … ${isRange._max.date ? d10(isRange._max.date) : '—'}   avg ${isRange._avg.topOfSearchIS != null ? (Number(isRange._avg.topOfSearchIS) * 100).toFixed(2) + '%' : '—'}`)
  const isByMkt = await prisma.amazonAdsPlacementReport.groupBy({
    by: ['marketplace'], _count: { _all: true }, _avg: { topOfSearchIS: true },
    where: { topOfSearchIS: { not: null } },
  })
  for (const r of isByMkt.sort((a, b) => a.marketplace.localeCompare(b.marketplace))) {
    line(`  ${r.marketplace}: ${r._count._all} campaign-days · avg ToS-IS ${(Number(r._avg.topOfSearchIS) * 100).toFixed(2)}%`)
  }
  const isCampaigns = await prisma.amazonAdsPlacementReport.findMany({
    where: { topOfSearchIS: { not: null } }, select: { campaignId: true }, distinct: ['campaignId'],
  })
  const campTotal = await prisma.campaign.count()
  line(`distinct campaigns with a ToS-IS reading: ${isCampaigns.length} of ${campTotal} campaigns`)
  const tosCron = await prisma.cronRun.findMany({ where: { jobName: 'tos-is-ingest' }, orderBy: { startedAt: 'desc' }, take: 5 })
  for (const r of tosCron) line(`  tos-is-ingest ${new Date(r.startedAt).toISOString()} ${r.status} ${r.outputSummary ?? r.errorMessage ?? ''}`)

  // ── B · The join the page depends on: keyword ↔ SQP query ────────────────
  h('B · Do our BID keywords and Amazon\'s SQP queries share a vocabulary?')
  const targets = await prisma.adTarget.findMany({
    where: { kind: 'KEYWORD', isNegative: false },
    select: { expressionValue: true, expressionType: true, adGroup: { select: { campaign: { select: { marketplace: true, name: true } } } } },
    take: 5000,
  })
  const bid = new Map<string, { text: string; mkt: string; types: Set<string> }>()
  for (const t of targets) {
    const kw = (t.expressionValue ?? '').trim().toLowerCase()
    const mk = t.adGroup?.campaign?.marketplace ?? ''
    if (!kw) continue
    const k = `${kw}|${mk}`
    if (!bid.has(k)) bid.set(k, { text: kw, mkt: mk, types: new Set() })
    bid.get(k)!.types.add(t.expressionType ?? '?')
  }
  const sqpRows = await prisma.searchQueryPerformance.findMany({ select: { searchQuery: true, marketplace: true, startDate: true } })
  const sqpPairs = new Set(sqpRows.map((r) => `${r.searchQuery.trim().toLowerCase()}|${r.marketplace}`))
  let exact = 0, substr = 0
  const sqpByMkt = new Map<string, string[]>()
  for (const r of sqpRows) {
    const m = r.marketplace
    if (!sqpByMkt.has(m)) sqpByMkt.set(m, [])
  }
  for (const [m] of sqpByMkt) sqpByMkt.set(m, [...new Set(sqpRows.filter((r) => r.marketplace === m).map((r) => r.searchQuery.trim().toLowerCase()))])
  for (const [k, v] of bid) {
    if (sqpPairs.has(k)) { exact++; continue }
    const pool = sqpByMkt.get(v.mkt) ?? []
    if (pool.some((q) => q.includes(v.text))) substr++
  }
  line(`bid keyword×market pairs: ${bid.size}`)
  line(`  exact match to an SQP query: ${exact}`)
  line(`  no exact match, but appears INSIDE at least one SQP query: ${substr}`)
  line(`  no SQP trace at all: ${bid.size - exact - substr}`)
  const mtypes = new Map<string, number>()
  for (const v of bid.values()) for (const t of v.types) mtypes.set(t, (mtypes.get(t) ?? 0) + 1)
  line(`  expressionType spellings on those targets: ${[...mtypes.entries()].map(([t, n]) => `${t}=${n}`).sort().join(' · ')}`)

  // ── C · What a watchlist row would carry, end to end ─────────────────────
  h('C · One assembled watchlist row per coverage-set term (the 97), IT')
  const sets = await prisma.keywordCoverageSet.findMany({ include: { terms: true } })
  const terms = sets.flatMap((s) => s.terms.map((t) => ({ term: t.term.trim().toLowerCase(), mkt: s.marketplace, lead: t.leadAsin })))
  const sqpFull = await prisma.searchQueryPerformance.findMany({
    select: { searchQuery: true, marketplace: true, startDate: true, asin: true, searchQueryVolume: true, searchQueryRank: true, impressionShare: true, clickShare: true, purchaseShare: true },
  })
  const stSince = new Date(Date.now() - 30 * 864e5)
  const st = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'marketplace'], _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true },
    where: { date: { gte: stSince } },
  })
  const stMap = new Map(st.map((r) => [`${r.query.trim().toLowerCase()}|${r.marketplace}`, r]))
  let withAny = 0, withSpend = 0, withFresh = 0
  const freshCut = Date.now() - 14 * 864e5
  const rowsOut: string[] = []
  for (const t of terms) {
    const mine = sqpFull.filter((r) => r.searchQuery.trim().toLowerCase() === t.term && r.marketplace === t.mkt)
    const spend = stMap.get(`${t.term}|${t.mkt}`)
    if (mine.length) withAny++
    if (spend) withSpend++
    if (mine.length && Math.max(...mine.map((r) => +r.startDate)) >= freshCut) withFresh++
    if (rowsOut.length < 10 && mine.length) {
      const latestTs = Math.max(...mine.map((r) => +r.startDate))
      const latest = mine.filter((r) => +r.startDate === latestTs)
      const bestShare = Math.max(...latest.map((r) => Number(r.impressionShare)))
      rowsOut.push(`${t.term.slice(0, 34).padEnd(34)} ${t.mkt} vol=${String(latest[0].searchQueryVolume).padStart(6)} mktRank=${String(latest[0].searchQueryRank ?? '—').padStart(5)} share=${(bestShare * 100).toFixed(3).padStart(7)}% asins=${String(latest.length).padStart(2)} week=${d10(new Date(latestTs))} spend30d=€${spend ? (Number(spend._sum.costMicros ?? 0n) / 1e6).toFixed(2) : '0.00'}`)
    }
  }
  line(`coverage-set terms: ${terms.length}`)
  line(`  with ANY SQP row ever:               ${withAny}`)
  line(`  with an SQP row < 14 days old:       ${withFresh}`)
  line(`  with paid spend in the last 30 days: ${withSpend}`)
  line()
  for (const r of rowsOut) line(`  ${r}`)

  // ── D · How stale is "latest" for every signal the page would show? ──────
  h('D · Freshness of every signal a row would carry')
  const now = Date.now()
  const age = (d: Date | null | undefined) => (d ? `${Math.round((now - +d) / 864e5)}d` : '—')
  const sqpMax = await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true, ingestedAt: true } })
  const stMax = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true } })
  const dpMax = await prisma.amazonAdsDailyPerformance.aggregate({ _max: { date: true } })
  const plMax = await prisma.amazonAdsPlacementReport.aggregate({ _max: { date: true } })
  const krMax = await prisma.keywordRank.aggregate({ _max: { capturedAt: true } })
  line(`SQP        latest period start ${sqpMax._max.startDate ? d10(sqpMax._max.startDate) : '—'} (${age(sqpMax._max.startDate)})   last ingest ${sqpMax._max.ingestedAt ? new Date(sqpMax._max.ingestedAt).toISOString() : '—'}`)
  line(`SearchTerm latest date         ${stMax._max.date ? d10(stMax._max.date) : '—'} (${age(stMax._max.date)})`)
  line(`DailyPerf  latest date         ${dpMax._max.date ? d10(dpMax._max.date) : '—'} (${age(dpMax._max.date)})`)
  line(`Placement  latest date         ${plMax._max.date ? d10(plMax._max.date) : '—'} (${age(plMax._max.date)})`)
  line(`KeywordRank latest capturedAt  ${krMax._max.capturedAt ? d10(krMax._max.capturedAt) : '— (no rows)'}`)

  // ── E · The five ex-KeywordRank consumers, so nothing is missed ─────────
  h('E · Everything that reads or writes KeywordRank')
  line('(static — from grep; listed here so the page design has the full wire list)')
  line('  READ : routes/advertising.routes.ts:7294  GET  /advertising/keyword-ranks')
  line('  WRITE: routes/advertising.routes.ts:7322  POST /advertising/keyword-ranks   (only writer)')
  line('  READ : jobs/advertising-rule-evaluator.job.ts:961  buildKeywordRankBidContexts()')
  line('  READ : web _shared/RuleBuilder.tsx:400            builder Preview rank column')
  line('  READ : web tabs/TrackerTab.tsx:61                 the Report grid')
  line('  no DELETE route exists — the grid\'s "Remove" button cannot persist')

  line()
  line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
