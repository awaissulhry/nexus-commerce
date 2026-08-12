/**
 * KT.1 / KT.1b — the Keyword Tracker's one read.
 *
 * The page answers one question: *on the keywords I chose, are we on the page — and is it moving?*
 * This service answers the first half of it from data this account already holds, and refuses to
 * answer the second half with a number it cannot source.
 *
 * Three things live here, deliberately as functions rather than inline in the route, because each
 * one is a decision that has to be testable on its own:
 *
 *   1. `resolveScope`      — market → product line → portfolio → campaign, cascading, most specific
 *                            wins. Pure: it takes the campaign/ad/product graph as data.
 *   2. `chooseViewPeriod`  — WHICH single weekly SQP period the whole view renders. Read its own
 *                            doc comment before touching it; it replaced a per-row rule that
 *                            silently ranked one week's population against another's.
 *   3. `getKeywordTracker` — the orchestrator that reads the database and assembles rows.
 *
 * ── 🔴 KT.1b superseded the period rule ───────────────────────────────────────────────────────
 * KT.1 gave each ROW its own period; KT.1b gives the whole VIEW one period. The KT.1 reasoning is
 * kept verbatim below, because the trap it avoided is real and the replacement still has to avoid
 * it: the answer was never "go back to the market's newest period", it was "pick the newest
 * COMPLETE one". `pickTermPeriod` was deleted rather than left exported — a tested function that
 * implements a known defect is an invitation.
 *
 * ── Why a row picked its own period (KT.1 — superseded, kept for the trap it names) ────────────
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
 *
 * (KT.1b keeps the bound and lowered it to 42 days. What it dropped is the *per-row* part: a term
 * whose newer row sits outside the view's period is now a `no-row-this-period` row that states when
 * it was last seen, instead of a share the rest of the grid cannot be compared against.)
 */
import prisma from '../../db.js'

/**
 * How far back a view may reach for its ONE period. 6 weekly SQP periods.
 *
 * KT.1b lowered this from 56. Measured 2026-08-12 (`scripts/_kt1b-period-gate.mts`), 42 and 56 pick
 * the SAME period in all four markets — IT 07-19, DE 07-19, ES 07-12, FR 07-12 — so 42 is strictly
 * tighter at zero cost today, and it makes the truncated-week warning appear two weeks sooner if the
 * feed keeps stalling. 28 was rejected: it truncates ES and FR, both of which have a COMPLETE week
 * 30 days back, and a complete week at 30 days beats a 17%-complete week at 16.
 */
export const KT_LOOKBACK_DAYS = 42

/**
 * A period qualifies when it holds at least this fraction of the rows a normal week holds in that
 * market. 0.5 = "at least half a normal week".
 *
 * Chosen from the measured constant space, not by taste. 2026-07-26 — the newest stored period —
 * holds 8 IT rows against a 655-row median, 5 DE against 428, 71 ES against 414, 1 FR against 69.
 * Every ratio from 0.3 to 0.6 rejects it in all four markets, so the ratio is not what saves IT.
 * What the ratio decides is ES 2026-07-19 at 193 rows (47% of a normal week): 0.4 accepts it, 0.5
 * rejects it and takes the complete 07-12 week instead. 0.5, because this page exists to compare
 * shares and half a week of coverage is not a share.
 */
export const SQP_COMPLETENESS_RATIO = 0.5

/** How many recent periods define "a normal week here". A quarter of weekly history. */
export const SQP_BASELINE_PERIODS = 12

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const KT_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

export type KtGrain = 'market' | 'line' | 'portfolio' | 'campaign'
export type KtMeasuredFilter = 'all' | 'yes' | 'no'
export type KtSortKey = 'keyword' | 'volume' | 'rank' | 'share' | 'asins' | 'asOf'

export interface KtScopeGraph {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null; status?: string }>
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
  // KT.1b — an ARCHIVED campaign is not part of "the campaigns in this market". It inflated the
  // denominator the page prints (1 of IT's 150) and the reach of a market-scoped view. It stays
  // resolvable by an explicit ?campaign= pick below, because the picker that offers it is fed by
  // another route this session must not touch, and a pick that silently resolved to nothing would
  // be worse than one that resolves to an archived campaign's real ASINs.
  const allInMarket = graph.campaigns.filter((c) => c.marketplace === req.market)
  const inMarket = allInMarket.filter((c) => c.status !== 'ARCHIVED')
  const campaignsWithoutPortfolio = inMarket.filter((c) => !c.portfolioId).length
  const lineOf = new Map(graph.products.map((p) => [p.id, p.parentId ?? p.id]))
  const marketCampaignIds = new Set(inMarket.map((c) => c.id))
  const adsInMarket = graph.ads.filter((a) => marketCampaignIds.has(a.campaignId))
  // an explicit pick may name an archived campaign; the coarser grains must not include one
  const allMarketCampaignIds = new Set(allInMarket.map((c) => c.id))
  const adsAllInMarket = graph.ads.filter((a) => allMarketCampaignIds.has(a.campaignId))

  const base = {
    campaignsWithoutPortfolio,
    campaignsInMarket: inMarket.length,
  }

  // campaign — most specific. A campaign id from another market resolves to nothing, which is
  // correct: the market picker and the campaign picker cannot disagree and both be honoured.
  if (req.campaign) {
    const c = allInMarket.find((x) => x.id === req.campaign)
    const ids = c ? [c.id] : []
    const asins = new Set(adsAllInMarket.filter((a) => ids.includes(a.campaignId) && a.asin).map((a) => a.asin!))
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

/** Row counts per SQP period for one market, in any order. */
export interface KtPeriodCandidate { start: Date; rows: number }

export type KtPeriodReason = 'complete' | 'incomplete-week' | 'outside-lookback' | 'no-data'

export interface KtChosenPeriod {
  start: Date | null
  /** rows the chosen period holds for this market (all queries, not just the watchlist) */
  rows: number
  /** the median row count of the last SQP_BASELINE_PERIODS periods — "a normal week here" */
  baselineRows: number
  /** rows a period needed to qualify */
  threshold: number
  reason: KtPeriodReason
  /** true unless `reason === 'complete'` — every share on the view is then suspect, loudly */
  truncated: boolean
  /** periods newer than the chosen one that failed the gate, newest first */
  rejected: Array<{ start: string; rows: number }>
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 🔴 THE fix of KT.1b: **a view renders exactly one SQP period.**
 *
 * KT.1 gave every ROW the newest period that held a row for its own term. That reads as freshness
 * and is really a ranking of one week against another: measured on prod, the IT default grid put
 * 95 terms on 2026-07-19 and 2 on 2026-07-26 — and 2026-07-26 is a truncated week holding **8 IT
 * rows against a 655-row median**. `giubbotto moto` fell from 1.56% to 0.01% purely because its
 * covered ASIN rows went 4 → 1, and rendered at share-rank #92 of 97 when its rank on a week both
 * it and its neighbours actually have is #11. 116 of the 190 cross-period pairs in that grid were
 * ordered wrongly. No amount of per-row date labelling fixes a sort key that mixes populations.
 *
 * So: pick the newest period inside the lookback that holds at least `ratio` of the rows a normal
 * week holds in that market, and render only that one. `now` is injectable so the choice is
 * testable without the clock.
 *
 * The baseline is a MEDIAN over a window wider than the lookback, deliberately: a lookback-local
 * median is dragged down by the very truncation it exists to catch. Measured — at ratio 0.5 over a
 * 28-day lookback, the local median accepts ES 2026-07-26 (71 rows, 17% of a normal week) while the
 * wider baseline rejects it. Same constants, opposite answer.
 */
export function chooseViewPeriod(
  periods: KtPeriodCandidate[],
  opts: { lookbackDays?: number; ratio?: number; baselinePeriods?: number; now?: number } = {},
): KtChosenPeriod {
  const lookbackDays = opts.lookbackDays ?? KT_LOOKBACK_DAYS
  const ratio = opts.ratio ?? SQP_COMPLETENESS_RATIO
  const baselinePeriods = opts.baselinePeriods ?? SQP_BASELINE_PERIODS
  const now = opts.now ?? Date.now()

  const sorted = [...periods].sort((a, b) => +b.start - +a.start)
  if (!sorted.length) {
    return { start: null, rows: 0, baselineRows: 0, threshold: 0, reason: 'no-data', truncated: true, rejected: [] }
  }

  const baselineRows = median(sorted.slice(0, baselinePeriods).map((p) => p.rows))
  const threshold = ratio * baselineRows
  const inLookback = sorted.filter((p) => (now - +p.start) / 86_400_000 <= lookbackDays)

  const rejected: Array<{ start: string; rows: number }> = []
  for (const p of inLookback) {
    if (p.rows >= threshold) {
      return { start: p.start, rows: p.rows, baselineRows, threshold, reason: 'complete', truncated: false, rejected }
    }
    rejected.push({ start: iso(p.start)!, rows: p.rows })
  }

  // Nothing qualified. Render the newest thing we have rather than an empty page — and say so.
  // Two different failures, because they need different sentences: the newest week inside the
  // window is partial, versus there is no week inside the window at all.
  const fallback = inLookback[0] ?? sorted[0]
  return {
    start: fallback.start,
    rows: fallback.rows,
    baselineRows,
    threshold,
    reason: inLookback.length ? 'incomplete-week' : 'outside-lookback',
    truncated: true,
    // `rejected` means "newer than the one we chose". On this path the chosen period is itself the
    // newest one available, so it — and everything older — must not be listed as skipped.
    rejected: rejected.filter((r) => Date.parse(r.start) > +fallback.start),
  }
}

/**
 * Why a row can be blank. KT.1 had one blank state and it covered two different facts —
 * measured on prod: DE 89 terms never measured vs 1 aged out; ES 94 vs 2; FR 94 vs 3, all four
 * rendering the same string. A term the feed has never reported and a term the feed reported three
 * weeks ago are different problems with different fixes, so they are different states.
 */
export type KtRowState =
  /** a row in the view's period — the only state that carries a share */
  | 'measured'
  /** the feed has this term in this market, but not in the period this view renders */
  | 'no-row-this-period'
  /** the feed has never reported this term in this market, at any period */
  | 'never-measured'

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
  state: KtRowState
  /** for `no-row-this-period`: the newest period this term DOES have, at any age. Else null. */
  lastSeen: string | null
  lastSeenAgeDays: number | null
  /** `state === 'measured'`. Kept so a client deployed before this field existed keeps working. */
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

  // ── the scope graph, the watchlist, the period candidates and the freshness probes, in ONE round ──
  // KT.1b — the period groupBy and the three freshness probes depend on nothing but `market`, so
  // they belong in this batch rather than in two more serial round trips. Measured: that ordering
  // alone was most of a 6.6s first paint.
  const [campaigns, ads, watchlists, periodGroups, sqpLatest, stLatest, plLatest] = await Promise.all([
    // KT.1b — `status` joins the select so an ARCHIVED campaign stops inflating the market's
    // campaign count (1 of IT's 150 is archived). See `resolveScope`: it is excluded from the
    // market set but still resolvable by an explicit ?campaign= pick, because the campaign picker
    // is fed by /advertising/scope-options, which is another session's route and unfiltered.
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true } }),
    // Only this market's ads: `resolveScope` filters by market anyway, and fetching the account's
    // whole ad graph (4,211 rows) to answer one market cost ~2s of the page's first paint.
    prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: market } } },
      select: { productId: true, asin: true, adGroup: { select: { campaignId: true } } },
    }),
    // KT.2 — the watchlists this market owns. `KeywordCoverageSet` is no longer read here at all:
    // it is the coverage engine's arming switch (see keyword-watchlist.service.ts's header) and the
    // tracker now has its own entity. It survives only as an import source, behind the CRUD routes.
    prisma.keywordWatchlist.findMany({
      select: { id: true, marketplace: true, name: true, isDefault: true, source: true, _count: { select: { terms: true } } },
      orderBy: [{ marketplace: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
    }),
    prisma.searchQueryPerformance.groupBy({ by: ['startDate'], where: { marketplace: market }, _count: { _all: true } }),
    prisma.searchQueryPerformance.findFirst({
      where: { marketplace: market }, orderBy: { startDate: 'desc' }, select: { startDate: true },
    }),
    prisma.amazonAdsSearchTerm.findFirst({ where: { marketplace: market }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.amazonAdsPlacementReport.findFirst({
      where: { marketplace: market, topOfSearchIS: { not: null } }, orderBy: { date: 'desc' }, select: { date: true },
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
  const scope = resolveScope(graph, { market, line: q.line, portfolio: q.portfolio, campaign: q.campaign })

  // ── names for whatever the operator picked, so the page can say it in words ──
  const [lineProduct, portfolioRow, campaignRow] = await Promise.all([
    q.line ? prisma.product.findUnique({ where: { id: q.line }, select: { id: true, sku: true, name: true } }) : null,
    q.portfolio
      ? prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: q.portfolio }, select: { externalPortfolioId: true, name: true } })
      : null,
    q.campaign ? prisma.campaign.findUnique({ where: { id: q.campaign }, select: { id: true, name: true } }) : null,
  ])

  // ── the watchlist ──────────────────────────────────────────────────────────
  // 🔴 KT.2 killed `?? sets[0]`. That fallback served one Italian list to all four markets, and
  // measured, only 8 of its 97 terms have EVER had a DE row (3 in ES, 3 in FR) — so DE/ES/FR's
  // near-empty grids were a wrong-list artefact, not a data gap. A market with no watchlist now
  // resolves to NOTHING and says so; it never borrows another market's terms.
  const marketLists = watchlists.filter((w) => w.marketplace === market)
  const chosenList = q.list
    // A list id from another market is refused rather than silently honoured — the same rule the
    // scope spine applies to a campaign id from the wrong market.
    ? marketLists.find((w) => w.id === q.list) ?? null
    : marketLists.find((w) => w.isDefault) ?? marketLists[0] ?? null
  /** true when the operator asked for a list that exists but belongs to another market */
  const listRejected = !!q.list && !chosenList && watchlists.some((w) => w.id === q.list)

  const listTerms = chosenList
    ? await prisma.keywordWatchlistTerm.findMany({
      where: { watchlistId: chosenList.id },
      select: { term: true, isBranded: true },
      orderBy: { term: 'asc' },
    })
    : []

  // KT.2 — branded is now a STORED per-term flag, classified on write by a function that honours
  // AdKeywordProtection's matchType and marketplace. Nothing is re-derived on read, so an operator
  // who flips one term keeps that decision.
  const brandedByTerm = new Map(listTerms.map((t) => [norm(t.term), t.isBranded]))
  const isBranded = (term: string) => brandedByTerm.get(term) ?? false

  const watchlist = [...new Set(listTerms.map((t) => norm(t.term)))].sort()
  const visibleTerms = includeBranded ? watchlist : watchlist.filter((t) => !isBranded(t))

  // ── the view's ONE period ──────────────────────────────────────────────────
  // The gate is MARKET-level, not scope-level, on purpose: it is measuring whether the FEED wrote a
  // whole week, which is a property of the feed. It also means every scope in a market renders the
  // same week, so two views of the same market can be compared with each other. Measured cost of
  // that choice: portfolio IT_Gale holds all 97 terms in the chosen week, while campaign "Gale
  // Jacket Yellow Only" holds 25 of 97 there against 47 in an older week — those 72 terms become
  // `no-row-this-period` rows carrying their own last-seen date, rather than a fresher number
  // pulled from a week the rest of the grid is not on.
  const chosen = chooseViewPeriod(periodGroups.map((p) => ({ start: p.startDate, rows: p._count._all })))

  // ── the share rows: the watchlist, in that one period ──
  const sqpRows = visibleTerms.length && chosen.start
    ? await prisma.searchQueryPerformance.findMany({
      where: {
        marketplace: market,
        startDate: chosen.start,
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

  // ── for every blank row, WHICH blank is it? ──
  // Deliberately unbounded by the lookback: this is a date to state, not a value to render, and
  // "last seen 14 Jun" is a more useful sentence than "never measured" is a true one.
  const blankTerms = visibleTerms.filter((t) => !byTerm.has(t))
  const lastSeen = new Map<string, Date>()
  if (blankTerms.length) {
    const seen = await prisma.searchQueryPerformance.groupBy({
      by: ['searchQuery'],
      where: {
        marketplace: market,
        searchQuery: { in: blankTerms },
        ...(scope.asinScoped ? { asin: { in: scope.asins } } : {}),
      },
      _max: { startDate: true },
    })
    for (const s of seen) if (s._max.startDate) lastSeen.set(norm(s.searchQuery), s._max.startDate)
  }

  const rows: KtRow[] = visibleTerms.map((term) => {
    const inPeriod = byTerm.get(term) ?? []
    const branded = isBranded(term)
    if (!inPeriod.length) {
      const seen = lastSeen.get(term) ?? null
      return {
        keyword: term, marketplace: market,
        marketVolume: null, marketRank: null, impressionShare: null,
        asinsCompeting: 0, asOf: null, asOfAgeDays: null,
        state: seen ? 'no-row-this-period' : 'never-measured',
        lastSeen: iso(seen), lastSeenAgeDays: ageDays(seen),
        measured: false, branded,
      }
    }
    // our BEST ASIN on this query — the one whose share we would be defending
    const best = inPeriod.reduce((a, b) => (b.impressionShare > a.impressionShare ? b : a))
    return {
      keyword: term, marketplace: market,
      marketVolume: best.searchQueryVolume,
      marketRank: best.searchQueryRank,
      impressionShare: best.impressionShare,
      asinsCompeting: new Set(inPeriod.map((r) => r.asin).filter((x): x is string => !!x)).size,
      asOf: iso(chosen.start),
      asOfAgeDays: ageDays(chosen.start),
      state: 'measured',
      lastSeen: null, lastSeenAgeDays: null,
      measured: true, branded,
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
  // sorting it to the top of a share column would read as "worst performer". Between the two blank
  // states, a term the feed knows but did not report this week outranks one it has never reported —
  // the first is a coverage gap you can chase, the second is a term Amazon has no data for.
  const stateRank = (r: KtRow) => (r.state === 'measured' ? 0 : r.state === 'no-row-this-period' ? 1 : 2)
  const sorted = [...filtered].sort((a, b) => {
    const ra = stateRank(a), rb = stateRank(b)
    return ra === rb ? cmp(a, b) : ra - rb
  })
  const page = sorted.slice(offset, offset + limit)

  // ── freshness, per source, for this market (probed in the batch above) ──
  const sqpIngested = sqpLatest
    ? await prisma.searchQueryPerformance.aggregate({
      where: { marketplace: market, startDate: sqpLatest.startDate }, _max: { ingestedAt: true },
    })
    : null

  // Retained deliberately: a commit is TWO deploys, and the client shipped by KT.1 reads
  // `window.periodsUsed.length` and `window.newestAsOf`. With one period per view this is now
  // always 0 or 1 entries long, which is exactly the point.
  const spread = new Map<string, number>()
  for (const r of filtered) if (r.asOf) spread.set(r.asOf, (spread.get(r.asOf) ?? 0) + 1)
  const periodsUsed = [...spread.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([start, terms]) => ({ start, terms }))

  const measuredCount = rows.filter((r) => r.state === 'measured').length
  const noRowCount = rows.filter((r) => r.state === 'no-row-this-period').length
  const neverCount = rows.filter((r) => r.state === 'never-measured').length

  return {
    scope: {
      market,
      boundBy: scope.boundBy,
      line: lineProduct ? { id: lineProduct.id, name: `${lineProduct.sku} — ${lineProduct.name}` } : null,
      portfolio: portfolioRow ? { id: portfolioRow.externalPortfolioId, name: portfolioRow.name } : null,
      campaign: campaignRow ? { id: campaignRow.id, name: campaignRow.name } : null,
      /**
       * KT.2 — a `KeywordWatchlist`, this market's own. `enabled` is deliberately ABSENT: it was
       * never a display flag, it is the coverage engine's arming switch, and this entity has no
       * such column. `source` replaces it as the honest thing to say about a list — where its
       * terms came from.
       */
      list: chosenList
        ? {
          id: chosenList.id,
          name: chosenList.name,
          marketplace: chosenList.marketplace,
          terms: listTerms.length,
          isDefault: chosenList.isDefault,
          source: chosenList.source,
        }
        : null,
      /** true when ?list= named a real list belonging to a DIFFERENT market — the UI must say so */
      listRejected,
      resolved: {
        campaigns: scope.campaignIds.length,
        asins: scope.asins.length,
        keywordsWatched: visibleTerms.length,
        keywordsMeasured: measuredCount,
        /** the two blank states, separated — see KtRowState */
        keywordsNoRowThisPeriod: noRowCount,
        keywordsNeverMeasured: neverCount,
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
      completenessRatio: SQP_COMPLETENESS_RATIO,
      baselinePeriods: SQP_BASELINE_PERIODS,
      /** 🔴 the one period this whole view renders. Every share on the grid is from this week. */
      period: iso(chosen.start),
      periodAgeDays: ageDays(chosen.start),
      /** rows the market has in that period, and in a normal week here — the gate, shown */
      periodRows: chosen.rows,
      baselineRows: chosen.baselineRows,
      threshold: Math.round(chosen.threshold),
      /** why this period: complete · incomplete-week · outside-lookback · no-data */
      reason: chosen.reason,
      truncated: chosen.truncated,
      /** newer periods the gate refused, newest first — so the page can name what it skipped */
      rejected: chosen.rejected,
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
    /**
     * KT.2 — this was returned by KT.1, typed by the client, and rendered nowhere. It is now the
     * picker's data source: every list for THIS market (the other markets' lists are deliberately
     * not offered — switching market is how you reach them).
     */
    lists: marketLists.map((w) => ({
      id: w.id, name: w.name, marketplace: w.marketplace, isDefault: w.isDefault, source: w.source, terms: w._count.terms,
    })),
  }
}
