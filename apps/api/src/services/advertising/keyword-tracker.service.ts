/**
 * KT.1 — the Keyword Tracker's one read.
 *
 * The page answers one question: *on the keywords I chose, are we on the page — and is it moving?*
 * This service answers the first half of it from data this account already holds, and refuses to
 * answer the second half with a number it cannot source.
 *
 * Three things live here, deliberately as functions rather than inline in the route, because each
 * one is a decision that has to be testable on its own:
 *
 *   1. `resolveScope`   — market → product line → portfolio → campaign, cascading, most specific
 *                         wins. Pure: it takes the campaign/ad/product graph as data.
 *   2. `pickTermPeriod` — WHICH weekly SQP period a row reads. See the note below; this is the one
 *                         place where measurement overruled the brief.
 *   3. `getKeywordTracker` — the orchestrator that reads the database and assembles rows.
 *
 * ── Why a row picks its own period ────────────────────────────────────────────────────────────
 * The brief said: take the latest SQP period that has rows for that market. Measured on prod
 * 2026-08-11 (`apps/api/scripts/_kt1-period.mts`), that rule renders an empty product:
 *
 *   market-latest period = 2026-07-26 in all four markets, and it holds 8 rows in IT, 5 in DE,
 *   71 in ES, 1 in FR. Against the 107-term watchlist that is IT 2 measured / 105 not, and
 *   DE / ES / FR 0 measured / 107 not.
 *
 *   The period BEFORE it (2026-07-19) holds 655 IT rows and 95 of the 97 curated terms.
 *
 * So each row reads the newest period, within a bounded lookback, that actually holds a row for
 * that term in that market — and carries its own `asOf` and `asOfAgeDays`. That is what the row's
 * `asOf` field and the grid's third law ("every row states the age of what it shows") are for.
 * Measured with that rule: IT 98 of 107 measured, row ages 16–51 days, 48 terms with more than
 * one of our own ASINs on them. The alternative was a grid of 105 blanks over a table that holds
 * the answer one week back.
 *
 * The lookback is bounded so a row can never silently show a share from an arbitrary distance:
 * unbounded, IT gains nothing (98 either way), DE gains 1 term at 58 days, ES 2 at 79+ days and
 * FR 3 at 72+ days. Those are not "how are we doing" numbers.
 */
import prisma from '../../db.js'

/** 8 weekly SQP periods. See the file header — bounded on purpose, and stated on screen. */
export const KT_LOOKBACK_DAYS = 56

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const KT_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

export type KtGrain = 'market' | 'line' | 'portfolio' | 'campaign'
export type KtMeasuredFilter = 'all' | 'yes' | 'no'
export type KtSortKey = 'keyword' | 'volume' | 'rank' | 'share' | 'asins' | 'asOf'

export interface KtScopeGraph {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  /** one row per AdProductAd that carries an ASIN, joined up to its campaign */
  ads: Array<{ productId: string | null; asin: string | null; campaignId: string }>
  /** every advertised product, with its parent (a line is a parent id; a parentless product is its own line) */
  products: Array<{ id: string; parentId: string | null }>
}

export interface KtScopeRequest {
  market: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
}

export interface KtResolvedScope {
  /** which grain actually bound the resolution — the most specific one supplied */
  boundBy: KtGrain
  campaignIds: string[]
  asins: string[]
  /** true when the scope restricts to a set of our ASINs (i.e. anything narrower than market) */
  asinScoped: boolean
  /** campaigns in this market carrying no portfolioId — what the portfolio grain cannot reach */
  campaignsWithoutPortfolio: number
  campaignsInMarket: number
}

/**
 * market → line → portfolio → campaign, cascading, most specific wins.
 *
 * Line and portfolio are different axes — a product grouping and a campaign grouping — so they do
 * not nest cleanly. The brief's rule is "most specific wins", so exactly one grain binds and the
 * caller is told which, rather than silently intersecting two things an operator picked separately.
 */
export function resolveScope(graph: KtScopeGraph, req: KtScopeRequest): KtResolvedScope {
  const inMarket = graph.campaigns.filter((c) => c.marketplace === req.market)
  const campaignsWithoutPortfolio = inMarket.filter((c) => !c.portfolioId).length
  const lineOf = new Map(graph.products.map((p) => [p.id, p.parentId ?? p.id]))
  const marketCampaignIds = new Set(inMarket.map((c) => c.id))
  const adsInMarket = graph.ads.filter((a) => marketCampaignIds.has(a.campaignId))

  const base = {
    campaignsWithoutPortfolio,
    campaignsInMarket: inMarket.length,
  }

  // campaign — most specific. A campaign id from another market resolves to nothing, which is
  // correct: the market picker and the campaign picker cannot disagree and both be honoured.
  if (req.campaign) {
    const c = inMarket.find((x) => x.id === req.campaign)
    const ids = c ? [c.id] : []
    const asins = new Set(adsInMarket.filter((a) => ids.includes(a.campaignId) && a.asin).map((a) => a.asin!))
    return { ...base, boundBy: 'campaign', campaignIds: ids, asins: [...asins].sort(), asinScoped: true }
  }

  // portfolio — Campaign.portfolioId is Amazon's EXTERNAL portfolio id, not a local row id.
  if (req.portfolio) {
    const ids = inMarket.filter((c) => c.portfolioId === req.portfolio).map((c) => c.id)
    const idSet = new Set(ids)
    const asins = new Set(adsInMarket.filter((a) => idSet.has(a.campaignId) && a.asin).map((a) => a.asin!))
    return { ...base, boundBy: 'portfolio', campaignIds: ids, asins: [...asins].sort(), asinScoped: true }
  }

  // line — a Product parent id. Its children's ASINs, and the campaigns advertising them.
  if (req.line) {
    const asins = new Set<string>()
    const ids = new Set<string>()
    for (const a of adsInMarket) {
      if (!a.productId || lineOf.get(a.productId) !== req.line) continue
      if (a.asin) asins.add(a.asin)
      ids.add(a.campaignId)
    }
    return { ...base, boundBy: 'line', campaignIds: [...ids].sort(), asins: [...asins].sort(), asinScoped: true }
  }

  // market — every campaign in it, and no ASIN restriction on the share query at all.
  const asins = new Set(adsInMarket.filter((a) => a.asin).map((a) => a.asin!))
  return { ...base, boundBy: 'market', campaignIds: [...marketCampaignIds].sort(), asins: [...asins].sort(), asinScoped: false }
}

export interface KtSqpRow {
  searchQuery: string
  asin: string | null
  startDate: Date
  searchQueryVolume: number
  searchQueryRank: number | null
  impressionShare: number
}

/**
 * The newest period, within the candidate rows, that holds a row for this term.
 *
 * Pure and separate because it is the page's central honesty decision: the answer becomes the
 * row's `asOf`, and a term with no candidate row at all is `measured: false` — which is a
 * different fact from a share measured at zero, and must never render the same way.
 */
export function pickTermPeriod(rows: KtSqpRow[]): Date | null {
  let latest: Date | null = null
  for (const r of rows) if (!latest || +r.startDate > +latest) latest = r.startDate
  return latest
}

export interface KtRow {
  keyword: string
  marketplace: string
  marketVolume: number | null
  marketRank: number | null
  /** 0..1 — SQP impressionShare for our BEST ASIN on this query. Never a rank wearing a share's label. */
  impressionShare: number | null
  /** how many of OUR ASINs hold a row on this query in the period the row read */
  asinsCompeting: number
  asOf: string | null
  asOfAgeDays: number | null
  /** false = no SQP row for this term in this market inside the lookback. NOT the same as share 0. */
  measured: boolean
  /** true when the term contains one of the AdKeywordProtection whitelist terms */
  branded: boolean
}

export interface KeywordTrackerQuery {
  market: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
  list?: string | null
  branded?: boolean
  measured?: KtMeasuredFilter
  sort?: KtSortKey
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null)
const ageDays = (d: Date | null | undefined) =>
  d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)) : null

/** Lowercased, whitespace-collapsed — the same normalisation AdKeywordProtection stores. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export async function getKeywordTracker(q: KeywordTrackerQuery) {
  const market = q.market
  const limit = Math.min(1000, Math.max(1, q.limit ?? 500))
  const offset = Math.max(0, q.offset ?? 0)
  const measuredFilter: KtMeasuredFilter = q.measured ?? 'all'
  const includeBranded = q.branded === true
  const sortKey: KtSortKey = q.sort ?? 'volume'
  const dir = q.dir === 'asc' ? 'asc' : 'desc'

  const since = new Date()
  since.setUTCDate(since.getUTCDate() - KT_LOOKBACK_DAYS)
  since.setUTCHours(0, 0, 0, 0)

  // ── the scope graph, the watchlist and the freshness probes, in one round ──
  const [campaigns, ads, protections, sets] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true } }),
    // Only this market's ads: `resolveScope` filters by market anyway, and fetching the account's
    // whole ad graph (4,211 rows) to answer one market cost ~2s of the page's first paint.
    prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: market } } },
      select: { productId: true, asin: true, adGroup: { select: { campaignId: true } } },
    }),
    prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true, marketplace: true } }),
    prisma.keywordCoverageSet.findMany({
      select: { id: true, name: true, marketplace: true, portfolioId: true, enabled: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const productIds = [...new Set(ads.map((a) => a.productId).filter((x): x is string => !!x))]
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true } })
    : []

  const graph: KtScopeGraph = {
    campaigns,
    ads: ads
      .filter((a) => a.adGroup?.campaignId)
      .map((a) => ({ productId: a.productId, asin: a.asin, campaignId: a.adGroup!.campaignId })),
    products,
  }
  const scope = resolveScope(graph, { market, line: q.line, portfolio: q.portfolio, campaign: q.campaign })

  // ── names for whatever the operator picked, so the page can say it in words ──
  const [lineProduct, portfolioRow, campaignRow] = await Promise.all([
    q.line ? prisma.product.findUnique({ where: { id: q.line }, select: { id: true, sku: true, name: true } }) : null,
    q.portfolio
      ? prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: q.portfolio }, select: { externalPortfolioId: true, name: true } })
      : null,
    q.campaign ? prisma.campaign.findUnique({ where: { id: q.campaign }, select: { id: true, name: true } }) : null,
  ])

  // ── the watchlist: the coverage set's terms + the protected whitelist terms ──
  // KT.1 reads the list that exists. It becomes a real editable object in KT.2 — no new table here.
  const chosenSet = q.list
    ? sets.find((s) => s.id === q.list) ?? null
    : sets.find((s) => s.marketplace === market) ?? sets[0] ?? null
  const setTerms = chosenSet
    ? await prisma.keywordCoverageTerm.findMany({ where: { setId: chosenSet.id }, select: { term: true } })
    : []

  const protectedTerms = [...new Set(protections.filter((p) => !p.marketplace || p.marketplace === market).map((p) => norm(p.term)))]
  const isBranded = (term: string) => protectedTerms.some((p) => term.includes(p))

  const watchlist = [...new Set([...setTerms.map((t) => norm(t.term)), ...protectedTerms])].sort()
  const visibleTerms = includeBranded ? watchlist : watchlist.filter((t) => !isBranded(t))

  // ── the share rows: every watchlist row for this market inside the lookback ──
  const sqpRows = visibleTerms.length
    ? await prisma.searchQueryPerformance.findMany({
      where: {
        marketplace: market,
        startDate: { gte: since },
        searchQuery: { in: visibleTerms },
        ...(scope.asinScoped ? { asin: { in: scope.asins } } : {}),
      },
      select: {
        searchQuery: true, asin: true, startDate: true,
        searchQueryVolume: true, searchQueryRank: true, impressionShare: true,
      },
    })
    : []

  const byTerm = new Map<string, KtSqpRow[]>()
  for (const r of sqpRows) {
    const k = norm(r.searchQuery)
    const list = byTerm.get(k) ?? []
    list.push({ ...r, impressionShare: Number(r.impressionShare) })
    byTerm.set(k, list)
  }

  const rows: KtRow[] = visibleTerms.map((term) => {
    const candidates = byTerm.get(term) ?? []
    const period = pickTermPeriod(candidates)
    if (!period) {
      return {
        keyword: term, marketplace: market,
        marketVolume: null, marketRank: null, impressionShare: null,
        asinsCompeting: 0, asOf: null, asOfAgeDays: null,
        measured: false, branded: isBranded(term),
      }
    }
    const inPeriod = candidates.filter((r) => +r.startDate === +period)
    // our BEST ASIN on this query — the one whose share we would be defending
    const best = inPeriod.reduce((a, b) => (b.impressionShare > a.impressionShare ? b : a))
    return {
      keyword: term, marketplace: market,
      marketVolume: best.searchQueryVolume,
      marketRank: best.searchQueryRank,
      impressionShare: best.impressionShare,
      asinsCompeting: new Set(inPeriod.map((r) => r.asin).filter((x): x is string => !!x)).size,
      asOf: iso(period),
      asOfAgeDays: ageDays(period),
      measured: true,
      branded: isBranded(term),
    }
  })

  const filtered = rows.filter((r) => (measuredFilter === 'yes' ? r.measured : measuredFilter === 'no' ? !r.measured : true))

  const cmp = (a: KtRow, b: KtRow) => {
    const s = dir === 'asc' ? 1 : -1
    switch (sortKey) {
      case 'keyword': return s * a.keyword.localeCompare(b.keyword)
      case 'rank': return s * ((a.marketRank ?? Number.MAX_SAFE_INTEGER) - (b.marketRank ?? Number.MAX_SAFE_INTEGER))
      case 'share': return s * ((a.impressionShare ?? -1) - (b.impressionShare ?? -1))
      case 'asins': return s * (a.asinsCompeting - b.asinsCompeting)
      case 'asOf': return s * ((a.asOf ? Date.parse(a.asOf) : 0) - (b.asOf ? Date.parse(b.asOf) : 0))
      case 'volume':
      default: return s * ((a.marketVolume ?? -1) - (b.marketVolume ?? -1))
    }
  }
  // Measured rows first regardless of direction: an unmeasured row has nothing to sort BY, and
  // sorting it to the top of a share column would read as "worst performer".
  const sorted = [...filtered].sort((a, b) => (a.measured === b.measured ? cmp(a, b) : a.measured ? -1 : 1))
  const page = sorted.slice(offset, offset + limit)

  // ── freshness, per source, for this market ──
  const [sqpLatest, stLatest, plLatest] = await Promise.all([
    prisma.searchQueryPerformance.findFirst({
      where: { marketplace: market }, orderBy: { startDate: 'desc' }, select: { startDate: true },
    }),
    prisma.amazonAdsSearchTerm.findFirst({ where: { marketplace: market }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.amazonAdsPlacementReport.findFirst({
      where: { marketplace: market, topOfSearchIS: { not: null } }, orderBy: { date: 'desc' }, select: { date: true },
    }),
  ])
  const sqpIngested = sqpLatest
    ? await prisma.searchQueryPerformance.aggregate({
      where: { marketplace: market, startDate: sqpLatest.startDate }, _max: { ingestedAt: true },
    })
    : null

  // which periods the rendered rows actually read — the page states this rather than implying
  // one date for the whole grid
  const spread = new Map<string, number>()
  for (const r of filtered) if (r.asOf) spread.set(r.asOf, (spread.get(r.asOf) ?? 0) + 1)
  const periodsUsed = [...spread.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([start, terms]) => ({ start, terms }))

  const measuredCount = rows.filter((r) => r.measured).length

  return {
    scope: {
      market,
      boundBy: scope.boundBy,
      line: lineProduct ? { id: lineProduct.id, name: `${lineProduct.sku} — ${lineProduct.name}` } : null,
      portfolio: portfolioRow ? { id: portfolioRow.externalPortfolioId, name: portfolioRow.name } : null,
      campaign: campaignRow ? { id: campaignRow.id, name: campaignRow.name } : null,
      list: chosenSet ? { id: chosenSet.id, name: chosenSet.name, marketplace: chosenSet.marketplace, terms: setTerms.length } : null,
      resolved: {
        campaigns: scope.campaignIds.length,
        asins: scope.asins.length,
        keywordsWatched: visibleTerms.length,
        keywordsMeasured: measuredCount,
      },
      /**
       * Stated whenever the portfolio grain is in play, because it is the grain with a hole in it:
       * only 72 of 220 campaigns carry a portfolioId (measured 2026-08-11), so a portfolio-scoped
       * view is blind to the rest and must say so rather than look complete.
       */
      unreachable: q.portfolio
        ? {
          campaignsWithoutPortfolio: scope.campaignsWithoutPortfolio,
          campaignsInMarket: scope.campaignsInMarket,
        }
        : null,
    },
    window: {
      lookbackDays: KT_LOOKBACK_DAYS,
      periodsUsed,
      newestAsOf: periodsUsed[0]?.start ?? null,
      oldestAsOf: periodsUsed[periodsUsed.length - 1]?.start ?? null,
    },
    freshness: {
      sqp: {
        latestPeriodStart: iso(sqpLatest?.startDate ?? null),
        ingestedAt: sqpIngested?._max.ingestedAt ? new Date(sqpIngested._max.ingestedAt).toISOString() : null,
        ageDays: ageDays(sqpLatest?.startDate ?? null),
      },
      searchTerm: { latestDate: iso(stLatest?.date ?? null), ageDays: ageDays(stLatest?.date ?? null) },
      placement: { latestDate: iso(plLatest?.date ?? null), ageDays: ageDays(plLatest?.date ?? null) },
    },
    rows: page,
    total: filtered.length,
    lists: sets.map((s) => ({ id: s.id, name: s.name, marketplace: s.marketplace, enabled: s.enabled })),
  }
}
