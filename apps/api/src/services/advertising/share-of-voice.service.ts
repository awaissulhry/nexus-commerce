/**
 * SOV.0 — the Share of Voice page's one read.
 *
 * The page answers one question: **on the queries that matter, how much of each market do we hold?**
 * SOV.0 answers it with exactly ONE metric column — market impression share — because the four
 * things underneath it (scope resolution, the period gate, the blank-state contract and the
 * coverage statement) are what every later column inherits. If one of those is wrong, every column
 * added later is wrong in the same way.
 *
 * ── What this service deliberately does NOT do ────────────────────────────────────────────────
 * It does not compute a second "share". `sovPct` (`ads-impression-share.service.ts`) divides by
 * 498,606 impressions against a real campaign-grain total of 1,765,323 — 28.2% — because Amazon's
 * search-term report returns only CLICKED queries and 76% of our impressions are on product detail
 * pages. That number is not renamed here, it is simply not read. The old route keeps serving its
 * CSV; this one lives beside it.
 *
 * It does not fork the scope resolver or the period gate. Both are imported from
 * `keyword-tracker.service.ts`. A second scope resolver is how two pages start disagreeing about
 * our share, and the period gate cost KT a whole session to get right (KT.1b).
 *
 * ── The three decisions that are this service's own ───────────────────────────────────────────
 *
 * 1. THE POPULATION IS THE MARKET, NOT A WATCHLIST. Keyword Tracker is a watchlist view — a term is
 *    there because a human put it there. Share of Voice is a market view — a term is there because
 *    a market exists. So the rows are the queries Brand Analytics reports for this MARKET in the
 *    chosen period, and `?list=` is a filter over that, not the source of it. This is the
 *    deliberate inverse of KT, which defaults to its list.
 *
 *    Measured 2026-08-12 (`_sov0-states.mts`) — why the population is the chosen period and not a
 *    six-week union, which was the other candidate:
 *
 *      market | chosen-period rows | 42-day union | blank under the union
 *      IT     | 482                | 1,520        | 1,038 (68%)
 *      DE     | 276                | 1,040        |   764 (73%)
 *      ES     | 316                |   697        |   381 (55%)
 *      FR     |  37                |    77        |    40 (52%)
 *
 *    A market view that is two-thirds dashes is not a market view. The union's extra rows are a
 *    trend fact — they belong to SOV.1's week-over-week Δ, where the blank has a meaning.
 *
 * 2. THE VALUE IS A SUM OVER OUR ASINs, NOT OUR BEST ONE. KT reads its best ASIN's share, because
 *    its question is "the term I am defending". This page's question is "how much of this market do
 *    we hold", and that is every ASIN of ours on the query. Safe to sum, verified on prod:
 *      · 0 of 482 IT queries have ASIN rows that DISAGREE about `impressionsTotal` (so the market
 *        total is genuinely one number repeated per ASIN row, and summing it would multiply it)
 *      · 0 queries where Σ `impressionsBrand` exceeds `impressionsTotal`
 *      · 0 brand-level (`asin = null`) rows that would double-count
 *      · 0 of 655 rows where the stored `impressionShare` differs from brand/total by >2bp
 *
 * 3. 🔴 `null` AND `0` ARE NEVER COALESCED. `share()` (`sqp.service.ts:75`) returns `0` when the
 *    market total is `0`, so "Amazon reported no market total" and "we hold none of this market"
 *    arrive at a UI identically. This service never calls it. A row carries `share: null` when
 *    there is nothing to divide by, and a real `0` when there is. Four row states carry the rest of
 *    the distinction — see `SovRowState`.
 */
import prisma from '../../db.js'
import {
  resolveScope, chooseViewPeriod,
  KT_LOOKBACK_DAYS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS,
  type KtScopeGraph,
} from './keyword-tracker.service.js'
import { classifyBranded, normTerm, type ProtectionRule } from './keyword-watchlist.service.js'

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const SOV_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

/**
 * `?weeks=` — how far back the view may reach for its ONE period, in weeks.
 *
 * 🔴 This control is NOT decoration and it is not a trend window: SOV.0 renders one period, so the
 * only thing a history bound can change is WHICH period — and it does change it. Measured on prod
 * 2026-08-12 (`_sov0-weeks.mts`), moving it moves the whole grid:
 *
 *   weeks=4 (28d) → ES and FR have no complete week inside the bound, so both fall to the
 *                   truncated-week branch and render 2026-07-26: 71 ES rows against a 414-row
 *                   normal week, 1 FR row against 69. Every share on the grid changes.
 *   weeks=8 (56d) → the default. IT/DE 2026-07-19, ES/FR 2026-07-12.
 *   weeks=13 (91d) → same four periods as 8 today.
 *
 * The default is 8 = 56 days rather than KT's shipped `KT_LOOKBACK_DAYS` (42). KT.1b measured 42
 * and 56 as picking the SAME period in all four markets, and I re-verified it on today's data, so
 * the two sibling pages agree today. `KT_LOOKBACK_DAYS` is still imported and reported in the
 * payload, so the day they diverge the page can say which bound it used and why they differ.
 */
export const SOV_WEEKS = [4, 8, 13] as const
export const SOV_DEFAULT_WEEKS = 8

export type SovWeeks = (typeof SOV_WEEKS)[number]
export type SovKind = 'keyword' | 'asin' | 'all'
export type SovSortKey = 'query' | 'volume' | 'rank' | 'share' | 'asins'

/**
 * Why a row is blank — four states, never rendered the same way.
 *
 * A blank that means four things is worse than no column, which is the defect this page is
 * replacing: `share()` coerces "no market total" and "we hold none" to one `0`.
 */
export type SovRowState =
  /** a scoped SQP row in the chosen period. The only state that carries a share — including a real 0 */
  | 'measured'
  /**
   * the MARKET has this query in the chosen period, but none of the scope's ASINs do. Only
   * reachable when the scope is narrower than the market: Brand Analytics reports on 10 ASINs per
   * market per run, so a portfolio or campaign outside that set is invisible to it rather than
   * absent from the market. Measured: IT portfolio 190601227863497 holds 40 ASINs and 0 of the
   * market's 482 queries; portfolio 255127157311072 holds 433 of them and misses 49.
   */
  | 'not-covered'
  /** the feed has this query in this market, but not in the period this view renders */
  | 'no-row-this-period'
  /** the feed has never reported this query in this market, at any period */
  | 'never-measured'

export interface SovRow {
  query: string
  marketplace: string
  /** whole-market searches for this query in the period. Not our impressions. */
  marketVolume: number | null
  /** the QUERY's popularity rank in the marketplace (#1 = most searched). Not our position. */
  marketRank: number | null
  /** whole-market impressions for this query in the period — the denominator, stated */
  marketImpressions: number | null
  /** OUR impressions, summed over the scope's ASINs. `0` is a finding, `null` is an absence. */
  ourImpressions: number | null
  /**
   * 0..1, or null. 🔴 NEVER coalesced: null means "nothing to divide by" (no row, or a zero market
   * total), 0 means "a real market total and we hold none of it".
   */
  share: number | null
  /** how many of OUR scoped ASINs hold a row on this query in the chosen period */
  asinsCompeting: number
  state: SovRowState
  /** for `no-row-this-period`: the newest period this query DOES have. Unbounded by the lookback. */
  lastSeen: string | null
  lastSeenAgeDays: number | null
  /** true when the query contains one of the AdKeywordProtection whitelist terms */
  branded: boolean
  /** true when the query text is ASIN-shaped. Measured 0 in SQP, all markets, all-time — see facets. */
  asinLike: boolean
  /** on the chosen watchlist for this market */
  onList: boolean
}

export interface ShareOfVoiceQuery {
  market: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
  list?: string | null
  weeks?: number | null
  branded?: boolean
  kind?: SovKind
  q?: string | null
  sort?: SovSortKey
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null)
const ageDays = (d: Date | null | undefined) =>
  d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)) : null

/** B + 9 alphanumerics. 643 of 5,383 AD-side queries are these; SQP has 0, all markets, all-time. */
const ASIN_RE = /^b0[a-z0-9]{8}$/i

export async function getShareOfVoice(q: ShareOfVoiceQuery) {
  const market = q.market
  const limit = Math.min(2000, Math.max(1, q.limit ?? 1000))
  const offset = Math.max(0, q.offset ?? 0)
  const weeks: number = (SOV_WEEKS as readonly number[]).includes(q.weeks ?? 0) ? q.weeks! : SOV_DEFAULT_WEEKS
  const includeBranded = q.branded === true
  const kind: SovKind = q.kind ?? 'keyword'
  const sortKey: SovSortKey = q.sort ?? 'volume'
  const dir = q.dir === 'asc' ? 'asc' : 'desc'
  const needle = (q.q ?? '').trim().toLowerCase()

  // ── one round trip for everything that depends only on `market` ─────────────
  // KT.1b measured this ordering as most of a 6.6s first paint when it was serial. The period
  // groupBy and both freshness probes depend on nothing but the market, so they belong here.
  const [campaigns, ads, watchlists, periodGroups, sqpLatest, adsLatest, protections] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true } }),
    prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: market } } },
      select: { productId: true, asin: true, adGroup: { select: { campaignId: true } } },
    }),
    prisma.keywordWatchlist.findMany({
      where: { marketplace: market },
      select: { id: true, marketplace: true, name: true, isDefault: true, source: true, _count: { select: { terms: true } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
    prisma.searchQueryPerformance.groupBy({ by: ['startDate'], where: { marketplace: market }, _count: { _all: true } }),
    prisma.searchQueryPerformance.findFirst({ where: { marketplace: market }, orderBy: { startDate: 'desc' }, select: { startDate: true } }),
    prisma.amazonAdsSearchTerm.findFirst({ where: { marketplace: market }, orderBy: { date: 'desc' }, select: { date: true } }),
    // The same classifier KT.2 stores its per-term flag with. Never a second definition of "brand".
    prisma.adKeywordProtection.findMany({
      where: { mode: 'WHITELIST' },
      select: { term: true, matchType: true, isPrefix: true, marketplace: true },
    }),
  ])

  const productIds = [...new Set(ads.map((a) => a.productId).filter((x): x is string => !!x))]
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true } })
    : []

  const graph: KtScopeGraph = {
    campaigns: campaigns.map((c) => ({ ...c, status: String(c.status) })),
    ads: ads
      .filter((a) => a.adGroup?.campaignId)
      .map((a) => ({ productId: a.productId, asin: a.asin, campaignId: a.adGroup!.campaignId })),
    products,
  }
  // 🔴 Imported, never adapted. One implementation serves both pages, so they cannot disagree about
  // which campaigns a portfolio reaches. Cascading, most-specific-wins; archived campaigns are out
  // of the coarse grains but still reachable by an explicit ?campaign=.
  const scope = resolveScope(graph, { market, line: q.line, portfolio: q.portfolio, campaign: q.campaign })

  const [lineProduct, portfolioRow, campaignRow] = await Promise.all([
    q.line ? prisma.product.findUnique({ where: { id: q.line }, select: { id: true, sku: true, name: true } }) : null,
    q.portfolio
      ? prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: q.portfolio }, select: { externalPortfolioId: true, name: true } })
      : null,
    q.campaign ? prisma.campaign.findUnique({ where: { id: q.campaign }, select: { id: true, name: true } }) : null,
  ])

  // ── the view's ONE period ───────────────────────────────────────────────────
  // Market-level on purpose, exactly as KT: the gate measures whether the FEED wrote a whole week,
  // which is a property of the feed, not of a scope. It also means every scope in a market renders
  // the same week, so two views of one market can be compared with each other.
  const chosen = chooseViewPeriod(
    periodGroups.map((p) => ({ start: p.startDate, rows: p._count._all })),
    { lookbackDays: weeks * 7 },
  )

  // ── the watchlist, as a FILTER over the market — never as the population ────
  const chosenList = q.list && q.list !== 'all' ? watchlists.find((w) => w.id === q.list) ?? null : null
  /** true when ?list= named a list that exists but belongs to another market */
  const listRejected = !!q.list && q.list !== 'all' && !chosenList
    && (await prisma.keywordWatchlist.count({ where: { id: q.list } })) > 0
  const listTerms = chosenList
    ? await prisma.keywordWatchlistTerm.findMany({ where: { watchlistId: chosenList.id }, select: { term: true } })
    : []
  const listSet = new Set(listTerms.map((t) => normTerm(t.term)))

  // ── the market's rows for the chosen period, and the scope's rows within them ──
  // Two reads rather than one, because they answer two different questions: the market read is the
  // POPULATION (which queries exist here at all) and the scoped read is the VALUE. Collapsing them
  // is what makes `not-covered` indistinguishable from `never-measured`.
  const marketRows = chosen.start
    ? await prisma.searchQueryPerformance.findMany({
      where: { marketplace: market, startDate: chosen.start },
      select: {
        searchQuery: true, asin: true, impressionsTotal: true, impressionsBrand: true,
        searchQueryVolume: true, searchQueryRank: true,
      },
    })
    : []

  const scopedAsins = new Set(scope.asins)
  interface Agg { total: number; brand: number; vol: number; rank: number | null; asins: Set<string>; scopedRows: number }
  const marketAgg = new Map<string, Agg>()
  const scopedAgg = new Map<string, Agg>()
  const asinsSeen = new Set<string>()
  const add = (m: Map<string, Agg>, key: string, r: (typeof marketRows)[number]) => {
    const a = m.get(key) ?? { total: 0, brand: 0, vol: 0, rank: null, asins: new Set<string>(), scopedRows: 0 }
    // MAX, not sum: `impressionsTotal` is the whole market's count for the query, repeated on every
    // ASIN row of it. Verified on prod: 0 of 482 IT queries disagree across their rows.
    a.total = Math.max(a.total, r.impressionsTotal)
    a.brand += r.impressionsBrand
    a.vol = Math.max(a.vol, r.searchQueryVolume)
    if (r.searchQueryRank != null) a.rank = a.rank == null ? r.searchQueryRank : Math.min(a.rank, r.searchQueryRank)
    if (r.asin) a.asins.add(r.asin)
    a.scopedRows++
    m.set(key, a)
  }
  for (const r of marketRows) {
    add(marketAgg, r.searchQuery, r)
    if (r.asin) asinsSeen.add(r.asin)
    // `asinScoped` is false at market grain — KT's resolver says so, and it means "no ASIN
    // restriction on the share query at all", which is the market view by definition.
    if (!scope.asinScoped || (r.asin && scopedAsins.has(r.asin))) add(scopedAgg, r.searchQuery, r)
  }

  // ── the population: the market's queries, plus the list's terms when one is chosen ──
  const population = new Set<string>(marketAgg.keys())
  for (const t of listSet) if (!population.has(t)) population.add(t)

  // ── for every query with no scoped row, WHICH blank is it? ──
  // Only queries absent from the scoped period need the extra read, and it is deliberately
  // unbounded by the lookback: "last seen 14 Jun" is a more useful sentence at any age than
  // "never measured" is a true one.
  const blanks = [...population].filter((t) => !scopedAgg.has(t))
  const lastSeen = new Map<string, Date>()
  if (blanks.length) {
    const seen = await prisma.searchQueryPerformance.groupBy({
      by: ['searchQuery'],
      where: {
        marketplace: market,
        searchQuery: { in: blanks },
        ...(scope.asinScoped ? { asin: { in: scope.asins } } : {}),
      },
      _max: { startDate: true },
    })
    for (const s of seen) if (s._max.startDate) lastSeen.set(s.searchQuery, s._max.startDate)
  }

  const isBranded = (t: string) => classifyBranded(t, market, protections as ProtectionRule[])

  const allRows: SovRow[] = [...population].map((query) => {
    const mine = scopedAgg.get(query)
    const mkt = marketAgg.get(query)
    const branded = isBranded(query)
    const asinLike = ASIN_RE.test(query)
    const onList = listSet.has(normTerm(query))

    if (mine) {
      // 🔴 The one line this whole page exists to get right. A zero market total yields `null`
      // (Amazon reported nothing to divide by), NOT `0` (we hold none of a real market).
      const share = mine.total > 0 ? Math.max(0, Math.min(1, mine.brand / mine.total)) : null
      return {
        query, marketplace: market,
        marketVolume: mine.vol, marketRank: mine.rank,
        marketImpressions: mine.total, ourImpressions: mine.brand,
        share, asinsCompeting: mine.asins.size,
        state: 'measured', lastSeen: null, lastSeenAgeDays: null,
        branded, asinLike, onList,
      }
    }
    const seen = lastSeen.get(query) ?? null
    // The market has it this period and we do not: that is a COVERAGE fact (Brand Analytics reports
    // on ten ASINs per market), not an absence of demand. It can only arise below market grain.
    const state: SovRowState = mkt ? 'not-covered' : seen ? 'no-row-this-period' : 'never-measured'
    return {
      query, marketplace: market,
      // A not-covered row still knows the market's size — that is the whole point of separating it
      // from "never measured", which knows nothing.
      marketVolume: mkt ? mkt.vol : null,
      marketRank: mkt ? mkt.rank : null,
      marketImpressions: mkt ? mkt.total : null,
      ourImpressions: null, share: null, asinsCompeting: 0,
      state, lastSeen: iso(seen), lastSeenAgeDays: ageDays(seen),
      branded, asinLike, onList,
    }
  })

  // ── filters, then the census over the FULL filtered set ─────────────────────
  // No number this page renders is ever computed from a page of rows.
  const filtered = allRows.filter((r) => {
    if (!includeBranded && r.branded) return false
    if (kind === 'keyword' && r.asinLike) return false
    if (kind === 'asin' && !r.asinLike) return false
    if (chosenList && !r.onList) return false
    if (needle && !r.query.toLowerCase().includes(needle)) return false
    return true
  })

  const census = {
    total: filtered.length,
    measured: filtered.filter((r) => r.state === 'measured').length,
    noRowThisPeriod: filtered.filter((r) => r.state === 'no-row-this-period').length,
    neverMeasured: filtered.filter((r) => r.state === 'never-measured').length,
    notCovered: filtered.filter((r) => r.state === 'not-covered').length,
    /** a real market total and we hold none of it — a finding, not a blank */
    realZeros: filtered.filter((r) => r.state === 'measured' && r.share === 0).length,
    /** measured, but Amazon reported no market total to divide by — the tie `share()` hides */
    noMarketTotal: filtered.filter((r) => r.state === 'measured' && r.share === null).length,
  }

  // Facets count over the population BEFORE their own dimension is applied, so a chip can state
  // what turning it on would show rather than what is already showing.
  const facetBase = allRows.filter((r) => (chosenList ? r.onList : true) && (needle ? r.query.toLowerCase().includes(needle) : true))
  const facets = {
    branded: facetBase.filter((r) => r.branded).length,
    asinLike: facetBase.filter((r) => r.asinLike).length,
    byList: watchlists.map((w) => ({
      id: w.id, name: w.name, terms: w._count.terms, isDefault: w.isDefault, source: w.source,
    })),
  }

  // ── sort, then page ─────────────────────────────────────────────────────────
  const cmp = (a: SovRow, b: SovRow) => {
    const s = dir === 'asc' ? 1 : -1
    switch (sortKey) {
      case 'query': return s * a.query.localeCompare(b.query)
      case 'rank': return s * ((a.marketRank ?? Number.MAX_SAFE_INTEGER) - (b.marketRank ?? Number.MAX_SAFE_INTEGER))
      case 'share': return s * ((a.share ?? -1) - (b.share ?? -1))
      case 'asins': return s * (a.asinsCompeting - b.asinsCompeting)
      case 'volume':
      default: return s * ((a.marketVolume ?? -1) - (b.marketVolume ?? -1))
    }
  }
  // Measured rows first regardless of direction — a blank has nothing to sort BY, and sorting it to
  // the top of a share column reads as "worst performer". Between the blanks: a query the market
  // has but our ASINs are not covered on is a coverage gap you can chase; one the feed reported in
  // another week is a staleness fact; one it has never reported is neither.
  const stateRank = (r: SovRow) => (r.state === 'measured' ? 0 : r.state === 'not-covered' ? 1 : r.state === 'no-row-this-period' ? 2 : 3)
  const sorted = [...filtered].sort((a, b) => {
    const ra = stateRank(a), rb = stateRank(b)
    return ra === rb ? cmp(a, b) : ra - rb
  })
  const page = sorted.slice(offset, offset + limit)

  /** of the scope's ASINs, how many Brand Analytics actually reports on */
  const asinsWithSqpRows = scope.asins.filter((a) => asinsSeen.has(a)).length
  const asinsEver = scope.asins.length
    ? await prisma.searchQueryPerformance.findMany({
      where: { marketplace: market, asin: { in: scope.asins } }, select: { asin: true }, distinct: ['asin'],
    })
    : []

  return {
    scope: {
      market,
      boundBy: scope.boundBy,
      line: lineProduct ? { id: lineProduct.id, name: `${lineProduct.sku} — ${lineProduct.name}` } : null,
      portfolio: portfolioRow ? { id: portfolioRow.externalPortfolioId, name: portfolioRow.name } : null,
      campaign: campaignRow ? { id: campaignRow.id, name: campaignRow.name } : null,
      list: chosenList
        ? { id: chosenList.id, name: chosenList.name, terms: listTerms.length, isDefault: chosenList.isDefault, source: chosenList.source }
        : null,
      listRejected,
      resolved: {
        campaigns: scope.campaignIds.length,
        campaignsInMarket: scope.campaignsInMarket,
        /**
         * Stated ALWAYS, not only under a portfolio: 72 of 220 campaigns account-wide carry a
         * portfolioId, so the portfolio grain cannot reach 148 of them, and a picker that implies
         * otherwise is the defect. The page renders it as a warning only when it binds.
         */
        campaignsWithoutPortfolio: scope.campaignsWithoutPortfolio,
        asins: scope.asins.length,
        /** how many of those ASINs hold a row in the period this view renders */
        asinsWithSqpRows,
        /** …and how many hold one in any period. Coverage is 12.8% (IT) to 4.4% (FR). */
        asinsWithSqpRowsEver: asinsEver.length,
        /** the population before filters — the queries this market shows us in this period */
        queries: population.size,
      },
    },
    period: {
      asOf: iso(chosen.start),
      ageDays: ageDays(chosen.start),
      rows: chosen.rows,
      baselineRows: chosen.baselineRows,
      threshold: Math.round(chosen.threshold),
      reason: chosen.reason,
      truncated: chosen.truncated,
      /** newer periods the gate refused, newest first — so the page can name what it skipped */
      rejected: chosen.rejected,
      weeks,
      lookbackDays: weeks * 7,
      /** what KT's shipped gate uses. Reported so a divergence between the pages is visible. */
      ktLookbackDays: KT_LOOKBACK_DAYS,
      completenessRatio: SQP_COMPLETENESS_RATIO,
      baselinePeriods: SQP_BASELINE_PERIODS,
    },
    /**
     * 🔴 Two feeds, two ages, never one number. The market side is ~17 days behind by
     * configuration (`NEXUS_SQP_LOOKBACK` defaults to 2, so the newest week the cron can write is
     * always ~2 weeks old) and the ad side is 2 days behind. A single "last synced" chip would be
     * wrong whichever feed it named.
     *
     * Rendered inline by the page in a shape `<FreshnessChip>` can replace: freshness is
     * substrate-owned (spec §4 and §6.3) and Phase S has not happened. This is NOT a rival
     * freshness endpoint — it is two fields on the page's own read.
     */
    freshness: {
      sqp: { latest: iso(sqpLatest?.startDate ?? null), ageDays: ageDays(sqpLatest?.startDate ?? null) },
      ads: { latest: iso(adsLatest?.date ?? null), ageDays: ageDays(adsLatest?.date ?? null) },
    },
    census,
    facets,
    rows: page,
    total: filtered.length,
  }
}
