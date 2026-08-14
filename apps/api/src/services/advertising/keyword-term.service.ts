/**
 * KT.4 — one watched term: its series over time, our ASINs competing for it, and the campaigns
 * bidding it.
 *
 * The grid answers "which of my terms moved". This answers "why", for one of them, and it is the
 * operator's original question — *several products, same keywords, are they fighting each other* —
 * which nothing in this product has ever been able to show.
 *
 * ── What the data will and will not support (measured on prod 2026-08-12) ─────────────────────────
 *
 *   · **A series exists for most terms.** ≥3 weekly points: IT 73 of 97 · DE 10 of 21 · ES 6 of 7 ·
 *     FR 4 of 8. Nineteen IT terms have exactly one week — those get a dated point, never a line.
 *   · **Gaps are the norm, not the exception.** 46 of IT's 97 measured terms have a span longer
 *     than 7 days somewhere in their history (DE 7 of 21, ES 5 of 7, FR 3 of 8). A missing week is
 *     rendered as a gap, so the series is returned with its real dates and never re-indexed.
 *   · **The share series ends 23–30 days before the spend series.** Share is weekly and stopped at
 *     2026-07-19/07-12; spend is daily and runs to 2026-08-11. That gap is the feed's failure drawn
 *     to scale, so both series are returned on one timeline and neither is extended to meet the other.
 *   · **The SQP funnel dies below clicks.** Of 2,005 watchlist rows: impressionShare > 0 on 1,664,
 *     clickShare on 1,613, cartAddShare on 48, purchaseShare on **5**. So impression and click share
 *     are series; cart-adds and purchases are returned as COUNTS with their weeks and nothing is
 *     derived from them. No conversion rate comes off five rows.
 *   · **`AdTarget.spendCents/salesCents/impressions` are 0 for all 2,129 positive keyword targets**,
 *     so no metric here comes from `AdTarget` — only the bid, which is real.
 *   · **`expressionType` is the MATCH TYPE, not negativity.** Six spellings of two types exist
 *     (`EXACT`, `_EXACT`, `NEGATIVE_EXACT`, `PRODUCT_EXACT`, `PHRASE`, `_PHRASE`); negativity is
 *     `isNegative` and is filtered explicitly.
 */
import prisma from '../../db.js'
import { chooseViewPeriod, periodCoverageByMarket, resolveScope, KT_COVERAGE_FLOOR, type KtScopeGraph } from './keyword-tracker.service.js'

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null)
const ageDays = (d: Date | null | undefined) =>
  d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)) : null

/** Monday of the ISO week a date falls in — the bucket SQP itself uses for `startDate`. */
export function weekStart(d: Date): Date {
  const t = new Date(d)
  t.setUTCHours(0, 0, 0, 0)
  return new Date(+t - ((t.getUTCDay() + 6) % 7) * 86_400_000)
}

export interface KtTermPoint {
  /** ISO week start — the real date, never an index, so a gap stays a gap */
  week: string
  /** 0..1, our best ASIN's impression share that week; null when the week has spend but no share */
  share: number | null
  clickShare: number | null
  /** distinct ASINs of ours holding the query that week */
  asins: number | null
  spendCents: number | null
  clicks: number | null
  orders: number | null
}

export interface KtTermSeries {
  points: KtTermPoint[]
  /** weeks with a share reading — a LINE needs at least 3 */
  shareWeeks: number
  /** true when at least one consecutive pair is more than 7 days apart */
  hasGaps: boolean
  /** the last week with a share, and the last with spend — they differ by 23–30 days today */
  lastShareWeek: string | null
  lastSpendWeek: string | null
  /** days between them; the feed's silence, drawn */
  shareTrailsSpendByDays: number | null
  /** weeks newer than the gate's chosen period, excluded — see `capShareAt` */
  shareWeeksExcluded: number
}

/**
 * Build the series from real dates. Two rules this must not break:
 *   1. a week with no reading is ABSENT, not zero — the caller draws a gap;
 *   2. share and spend live on one timeline but neither is extended to the other's extent.
 * Pure, so both rules are testable without a database.
 */
export function buildSeries(
  shareRows: Array<{ week: string; share: number; clickShare: number; asin: string | null }>,
  spendRows: Array<{ week: string; cents: number; clicks: number; orders: number }>,
  /**
   * 🔴 The gate's chosen period, capping the SHARE series.
   *
   * Without this the chart re-admits exactly what KT.1b's completeness gate exists to keep off the
   * page. Caught before shipping: ES's gate picks 2026-07-12 because 07-19 holds 193 rows against a
   * 207-row threshold — yet 07-19 has rows for these terms, so the unbounded series ended there and
   * the drawer's newest point was a week the page had already judged incomplete, one line under a
   * header saying "as of 12 Jul". Spend is NOT capped: it is a different feed with a different
   * cadence, and its overhang is the thing worth seeing.
   */
  capShareAt?: string | null,
): KtTermSeries {
  const byWeek = new Map<string, KtTermPoint>()
  const asinsByWeek = new Map<string, Set<string>>()
  let shareWeeksExcluded = 0
  for (const r of shareRows) {
    if (capShareAt && r.week > capShareAt) { shareWeeksExcluded++; continue }
    const p = byWeek.get(r.week) ?? { week: r.week, share: null, clickShare: null, asins: null, spendCents: null, clicks: null, orders: null }
    // the row the grid renders is our BEST ASIN's, so the series follows the same rule
    p.share = Math.max(p.share ?? -1, r.share)
    p.clickShare = Math.max(p.clickShare ?? -1, r.clickShare)
    byWeek.set(r.week, p)
    if (r.asin) {
      const s = asinsByWeek.get(r.week) ?? new Set<string>()
      s.add(r.asin); asinsByWeek.set(r.week, s)
    }
  }
  for (const [w, s] of asinsByWeek) {
    const p = byWeek.get(w); if (p) p.asins = s.size
  }
  for (const r of spendRows) {
    const p = byWeek.get(r.week) ?? { week: r.week, share: null, clickShare: null, asins: null, spendCents: null, clicks: null, orders: null }
    p.spendCents = (p.spendCents ?? 0) + r.cents
    p.clicks = (p.clicks ?? 0) + r.clicks
    p.orders = (p.orders ?? 0) + r.orders
    byWeek.set(r.week, p)
  }
  const points = [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1))
  const shareOnly = points.filter((p) => p.share != null)
  const spendOnly = points.filter((p) => (p.spendCents ?? 0) > 0)
  // a gap is measured over the SHARE series: that is the one whose cadence is supposed to be weekly
  let hasGaps = false
  for (let i = 1; i < shareOnly.length; i++) {
    const d = (Date.parse(shareOnly[i].week) - Date.parse(shareOnly[i - 1].week)) / 86_400_000
    if (d > 7) { hasGaps = true; break }
  }
  const lastShareWeek = shareOnly.length ? shareOnly[shareOnly.length - 1].week : null
  const lastSpendWeek = spendOnly.length ? spendOnly[spendOnly.length - 1].week : null
  return {
    points,
    shareWeeks: shareOnly.length,
    hasGaps,
    lastShareWeek,
    lastSpendWeek,
    shareTrailsSpendByDays: lastShareWeek && lastSpendWeek
      ? Math.round((Date.parse(lastSpendWeek) - Date.parse(lastShareWeek)) / 86_400_000)
      : null,
    /** share rows dropped for belonging to a week the gate judged incomplete */
    shareWeeksExcluded: [...new Set(shareRows.filter((r) => capShareAt && r.week > capShareAt).map((r) => r.week))].length,
  }
}

export interface KeywordTermQuery {
  market: string
  keyword: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
}

export async function getKeywordTerm(q: KeywordTermQuery) {
  const market = q.market
  const term = norm(q.keyword)

  const [campaigns, ads, periodGroups, stLatest] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, externalCampaignId: true } }),
    prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: market } } },
      select: { productId: true, asin: true, adGroup: { select: { campaignId: true } } },
    }),
    prisma.searchQueryPerformance.groupBy({ by: ['startDate'], where: { marketplace: market }, _count: { _all: true } }),
    prisma.amazonAdsSearchTerm.findFirst({ where: { marketplace: market }, orderBy: { date: 'desc' }, select: { date: true } }),
  ])

  const productIds = [...new Set(ads.map((a) => a.productId).filter((x): x is string => !!x))]
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true, sku: true, name: true } })
    : []
  const graph: KtScopeGraph = {
    campaigns: campaigns.map((c) => ({ ...c, status: String(c.status) })),
    ads: ads.filter((a) => a.adGroup?.campaignId).map((a) => ({ productId: a.productId, asin: a.asin, campaignId: a.adGroup!.campaignId })),
    products: products.map((p) => ({ id: p.id, parentId: p.parentId })),
  }
  const scope = resolveScope(graph, { market, line: q.line, portfolio: q.portfolio, campaign: q.campaign })
  // KT.8 — the drawer gates on the same floor as the grid it opens from. A drawer that resolved a
  // different week would show a term's share for a period the row behind it is not on.
  const coverage = await periodCoverageByMarket(market)
  const chosen = chooseViewPeriod(
    periodGroups.map((p) => ({ start: p.startDate, rows: p._count._all, asins: coverage.get(+p.startDate) ?? 0 })),
    { floorAsins: KT_COVERAGE_FLOOR },
  )

  // ── the series: every week this term has, in scope ──
  const [shareHistory, spendHistory] = await Promise.all([
    prisma.searchQueryPerformance.findMany({
      where: {
        marketplace: market, searchQuery: term,
        ...(scope.asinScoped ? { asin: { in: scope.asins } } : { asin: { in: scope.asins } }),
      },
      select: {
        startDate: true, asin: true, impressionShare: true, clickShare: true,
        cartAddShare: true, purchaseShare: true, purchasesBrand: true, cartAddsBrand: true,
        searchQueryVolume: true, searchQueryRank: true,
      },
    }),
    prisma.amazonAdsSearchTerm.groupBy({
      by: ['date'],
      where: { marketplace: market, query: term },
      _sum: { costMicros: true, clicks: true, orders7d: true },
    }),
  ])

  const series = buildSeries(
    shareHistory.map((r) => ({
      week: iso(r.startDate)!, share: Number(r.impressionShare), clickShare: Number(r.clickShare), asin: r.asin,
    })),
    spendHistory.map((r) => ({
      week: iso(weekStart(r.date))!,
      cents: Math.round(Number(r._sum.costMicros ?? 0n) / 10_000),
      clicks: r._sum.clicks ?? 0,
      orders: r._sum.orders7d ?? 0,
    })),
    iso(chosen.start),
  )

  // ── the header: this term in the week the GRID reads, so drawer and row agree ──
  const inChosen = chosen.start ? shareHistory.filter((r) => +r.startDate === +chosen.start!) : []
  const best = inChosen.length
    ? inChosen.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a))
    : null
  const bound = inChosen.reduce((a, r) => a + Number(r.impressionShare), 0)

  // ── our ASINs on this term, in that week ──
  const asinsInWeek = inChosen.filter((r) => r.asin)
  const productByAsin = new Map<string, { sku: string; name: string }>()
  if (asinsInWeek.length) {
    const rows = await prisma.adProductAd.findMany({
      where: { asin: { in: asinsInWeek.map((r) => r.asin!) }, product: { isNot: null } },
      select: { asin: true, product: { select: { sku: true, name: true } } },
    })
    for (const r of rows) if (r.asin && r.product) productByAsin.set(r.asin, { sku: r.product.sku, name: r.product.name })
  }

  // ── the campaigns bidding it. `isNegative: false` explicitly; expressionType is the MATCH TYPE ──
  const targets = await prisma.adTarget.findMany({
    where: {
      isNegative: false,
      expressionValue: { in: [term] },
      adGroup: { campaign: { marketplace: market, ...(scope.boundBy === 'market' ? {} : { id: { in: scope.campaignIds } }) } },
    },
    select: {
      expressionType: true, bidCents: true, status: true, adGroupId: true,
      adGroup: { select: { id: true, name: true, campaignId: true, campaign: { select: { id: true, name: true, status: true, portfolioId: true } } } },
    },
  })
  const campMap = new Map<string, {
    id: string; name: string; status: string
    adGroups: Map<string, { id: string; name: string; matchTypes: Set<string>; bidCents: number[]; enabled: number; total: number }>
  }>()
  for (const t of targets) {
    const c = t.adGroup?.campaign
    if (!c) continue
    const entry = campMap.get(c.id) ?? { id: c.id, name: c.name, status: String(c.status), adGroups: new Map() }
    const g = entry.adGroups.get(t.adGroupId) ?? { id: t.adGroupId, name: t.adGroup!.name, matchTypes: new Set<string>(), bidCents: [], enabled: 0, total: 0 }
    g.matchTypes.add(t.expressionType)
    g.bidCents.push(t.bidCents)
    g.total += 1
    if (String(t.status) === 'ENABLED') g.enabled += 1
    entry.adGroups.set(t.adGroupId, g)
    campMap.set(c.id, entry)
  }
  const bidCampaigns = [...campMap.values()]
    .map((c) => ({
      id: c.id, name: c.name, status: c.status,
      adGroupCount: c.adGroups.size,
      matchTypes: [...new Set([...c.adGroups.values()].flatMap((g) => [...g.matchTypes]))].sort(),
      adGroups: [...c.adGroups.values()].map((g) => ({
        id: g.id, name: g.name,
        matchTypes: [...g.matchTypes].sort(),
        targets: g.total,
        enabledTargets: g.enabled,
        // the BID is real on AdTarget; its spend/sales/impressions are 0 for all 2,129 rows
        minBidCents: Math.min(...g.bidCents),
        maxBidCents: Math.max(...g.bidCents),
      })).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.adGroupCount - a.adGroupCount || a.name.localeCompare(b.name))

  const advertisedAsins = new Set(
    bidCampaigns.length
      ? graph.ads.filter((a) => bidCampaigns.some((c) => c.id === a.campaignId)).map((a) => a.asin).filter((x): x is string => !!x)
      : [],
  )

  // ── the funnel, as counts. Nothing is derived from them; see the file header ──
  const cartAddWeeks = shareHistory.filter((r) => Number(r.cartAddShare) > 0).length
  const purchaseWeeks = shareHistory.filter((r) => Number(r.purchaseShare) > 0 || r.purchasesBrand > 0).length

  return {
    term,
    market,
    scope: {
      boundBy: scope.boundBy,
      asinsInScope: scope.asins.length,
      campaignsInScope: scope.campaignIds.length,
    },
    /** the week the GRID reads, so the drawer's headline cannot disagree with the row it opened from */
    period: iso(chosen.start),
    periodAgeDays: ageDays(chosen.start),
    periodTruncated: chosen.truncated,
    header: best
      ? {
        marketVolume: best.searchQueryVolume,
        marketRank: best.searchQueryRank,
        share: Number(best.impressionShare),
        /** 🔴 an UPPER bound over our ASINs, never a total — impressions can overlap in one search */
        shareBound: asinsInWeek.length > 1 ? bound : null,
        bestAsin: best.asin,
        asinsOnQuery: new Set(asinsInWeek.map((r) => r.asin)).size,
      }
      : null,
    series,
    asins: asinsInWeek
      .map((r) => ({
        asin: r.asin!,
        sku: productByAsin.get(r.asin!)?.sku ?? null,
        name: productByAsin.get(r.asin!)?.name ?? null,
        share: Number(r.impressionShare),
        clickShare: Number(r.clickShare),
        /** is this ASIN actually advertised in the campaigns bidding this term? */
        advertisedOnTerm: advertisedAsins.has(r.asin!),
      }))
      .sort((a, b) => b.share - a.share),
    bidCampaigns,
    bid: {
      campaigns: bidCampaigns.length,
      adGroups: bidCampaigns.reduce((a, c) => a + c.adGroupCount, 0),
      matchTypes: [...new Set(bidCampaigns.flatMap((c) => c.matchTypes))].sort(),
      /** 🔴 the headline for IT: 64 of 97 watched terms have no campaign bidding them at all */
      unbid: bidCampaigns.length === 0,
    },
    funnel: {
      cartAddWeeks,
      purchaseWeeks,
      totalWeeks: series.points.filter((p) => p.share != null).length,
    },
    freshness: { searchTermLatest: iso(stLatest?.date ?? null) },
  }
}
