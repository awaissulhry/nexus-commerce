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
export type SovSortKey = 'query' | 'volume' | 'rank' | 'share' | 'clickShare' | 'delta' | 'asins' | 'adSpend'

/**
 * SOV.1 — why a row has no Δ. **The fifth state SOV.0's contract asks for, declared explicitly.**
 *
 * 🔴 It is a field of its OWN, not a fifth member of `SovRowState`, and that is a deliberate
 * deviation from the brief's literal shape. A row is simultaneously `measured` for impression share
 * and `delta-no-prior` for its Δ — those are two facts on two axes, and one enum cannot carry both
 * without the Δ column silently overwriting the share column's state. The brief's own wording
 * ("measured this period; the comparable prior week has no row for this query") describes exactly
 * that pairing. The token it names is kept verbatim.
 *
 * Why this is not cosmetic: measured on prod 2026-08-12, a comparable prior week exists for only
 * **18–28% of rows** (IT 136 of 482, DE 55 of 276, ES 57 of 316, FR 7 of 37) — and for **0%** at
 * `?market=FR&weeks=4`. Four rows in five have no Δ, so the reason they have none is most of what
 * this column communicates.
 */
export type SovDeltaState =
  /** both this period and the comparable prior period hold a scoped row — `deltaPt` is real */
  | 'delta-measured'
  /** measured this period; the comparable prior week has no row for this query in this scope */
  | 'delta-no-prior'
  /** not measured this period at all, so there is nothing to compare — the row is already blank */
  | 'delta-not-applicable'

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
  /** whole-market clicks for this query in the period */
  marketClicks: number | null
  /** OUR clicks, summed over the scope's ASINs. Same `null` ≠ `0` discipline as `share`. */
  ourClicks: number | null
  /**
   * 0..1, or null. `clicksBrand / clicksTotal` — of everyone who clicked SOMETHING for this query,
   * what fraction clicked us. Beside impression share it answers the one question impression share
   * cannot: we are on the page, are we being chosen?
   */
  clickShare: number | null
  /** our impression share in the comparable prior period, or null when there is no prior row */
  priorShare: number | null
  /**
   * The week-over-week change in PERCENTAGE POINTS, never a percentage of a percentage:
   * 1.71% → 1.83% is `+0.12`, not `+7`.
   */
  deltaPt: number | null
  deltaState: SovDeltaState
  /**
   * True when this query's whole-market impressions sit below the period's median — the denominator
   * is too small for its share to mean anything. `sappnetta knee spider nero` is "50.00%" of **4**
   * market impressions. Not hidden, never hidden — ranked below confident rows when sorting by a
   * share, and rendered muted.
   */
  lowConfidence: boolean
  /**
   * 🔴 The SAME test, on the click denominator, because it is a different and much smaller number.
   *
   * Found by measuring, not by reading: filtering the click column by `lowConfidence` (an
   * impressions test) still surfaced `giacca moto 3xl` at "25.00% click share" — **1 of 4 market
   * clicks** — on a row whose 5,364 market impressions clear the impression floor comfortably. A
   * query can be well-measured for impressions and have four clicks in the whole market. One flag
   * cannot police two denominators.
   */
  lowConfidenceClicks: boolean
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
  /**
   * SOV.2 — the AD side of the same query, over `?adWindow=` days (its OWN window: the SQP side is
   * weekly and ~17 days behind, the ad side is daily and ~2 behind — one control must never move
   * both grains). From AmazonAdsSearchTerm, scoped to the resolved campaigns. `null` = no ad
   * activity on this query in the window, which is a fact, not an absence of data.
   */
  ad: {
    impressions: number
    clicks: number
    spendCents: number
    /** null, never 0, when there were no clicks */
    cpcCents: number | null
    /** this query's spend as a share of the SCOPE's ad spend in the window; null on a zero total */
    spendShare: number | null
    campaigns: number
  } | null
  /**
   * SOV.3 — the judgement signals, re-cut against MEDIANS (the legacy service's outbid bar used
   * the MEAN of impressions, which 1,925 of 1,992 queries sit below — a flag firing on 32% of the
   * account is a census, not a signal). A row can carry several; the filter matches inclusion.
   *   outbid          — above-median CPC AND below-median ad impressions: probably losing the auction
   *   weak-relevance  — ≥50 ad impressions AND CTR under half the median: we show, we are not chosen
   *   cannibalized    — ≥2 of our campaigns buying the same query
   */
  signals: SovSignal[]
  /**
   * SOV.4 — demand we already appear in organically and never buy: measured presence this period
   * (our impressions > 0), no ad activity in the window, and no ENABLED positive keyword target
   * with this text. The boundary with Keyword Harvest is deliberate: harvest promotes terms we
   * already PAID on; these were never touched.
   */
  unbid: boolean
}

export type SovSignal = 'outbid' | 'weak-relevance' | 'cannibalized'
export const SOV_SIGNALS: readonly SovSignal[] = ['outbid', 'weak-relevance', 'cannibalized']
export const SOV_AD_WINDOWS = [7, 14, 30] as const
export const SOV_DEFAULT_AD_WINDOW = 30

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
  /** SOV.2 — the AD side's own window in days (7|14|30). Independent of `weeks` by design. */
  adWindow?: number | null
  /** SOV.3 — narrow the grid to one signal. Census counts stay pre-narrowing. */
  signal?: string | null
  /** SOV.4 — 'unbid' narrows to measured presence with no ad activity and no keyword target. */
  view?: string | null
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null)
const ageDays = (d: Date | null | undefined) =>
  d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)) : null

/** B + 9 alphanumerics. 643 of 5,383 AD-side queries are these; SQP has 0, all markets, all-time. */
const ASIN_RE = /^b0[a-z0-9]{8}$/i

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** One SQP period, with the count that decides whether its values are usable at all. */
export interface SovPeriodStat {
  start: Date
  rows: number
  /** rows carrying `impressionsBrand > 0`. Zero across a whole period is the parser defect below. */
  nonZeroRows: number
}

export interface SovPriorPeriod {
  start: Date | null
  rows: number
  /** days between the prior period's start and the chosen one's. NOT always 7 — see below. */
  gapDays: number | null
  reason: 'comparable' | 'no-older-period' | 'all-older-excluded'
  /** every older period this passed over, and why — so the page can name what it skipped */
  excluded: Array<{ asOf: string; rows: number; reason: 'all-zero' | 'below-threshold' }>
}

/**
 * 🔴 Pick the period a Δ compares against. Three rules, and the middle one is the whole point.
 *
 * **1. Strictly older than the chosen period.**
 *
 * **2. Not an all-zero week — COMPUTED, never a hard-coded date list.**
 * Fourteen periods across the four markets carry `impressionsBrand = 0` on 100% of their rows:
 * IT 2026-06-07 (462 rows) · 05-31 (158) · 05-24 (376) · 05-17 (1) · DE 06-07 (234) · 05-31 (84) ·
 * ES 06-07 (290) · 05-31 (433) · 05-24 (569) · 05-17 (124) · FR 06-07 (61) · 05-31 (135) ·
 * 05-24 (177) · 05-17 (183). That is the pre-`ACR.0.2` parser defect `sqp.service.ts`'s own header
 * documents — *"the 'our side' counts were reading 0 on every one of 9,232 prod rows while the
 * totals read 53.1M"* — in weeks that were never re-ingested. A Δ from 2026-07-19 back to
 * 2026-06-07 would report a total collapse that never happened.
 *
 * A hard-coded list would rot the day a week is re-ingested, and a stale exclusion that silently
 * stops matching is worse than none. So it is derived from the data every time. Independent
 * corroboration that this is a defect and not a fact: `clicksBrand > 0` is **0 rows** in every one
 * of those weeks and near-100% in every later one — two counts cannot both collapse and recover.
 *
 * **3. Clears the SAME completeness threshold as the chosen period.** A thin week is no more
 * comparable as a baseline than it is as a view.
 *
 * 🔴 The gap is NOT always 7 days. At `?market=ES&weeks=4` the chosen period is 2026-07-26 and the
 * nearest comparable prior is 2026-07-12 — **14 days**. Callers must render the date, never the
 * words "vs last week", unless `gapDays === 7`.
 */
export function choosePriorPeriod(
  periods: SovPeriodStat[],
  chosen: Date | null,
  threshold: number,
): SovPriorPeriod {
  const excluded: SovPriorPeriod['excluded'] = []
  if (!chosen) return { start: null, rows: 0, gapDays: null, reason: 'no-older-period', excluded }

  const older = periods
    .filter((p) => +p.start < +chosen)
    .sort((a, b) => +b.start - +a.start)
  if (!older.length) return { start: null, rows: 0, gapDays: null, reason: 'no-older-period', excluded }

  for (const p of older) {
    // A period can be all-zero AND pass the completeness gate — IT 2026-06-07 holds 462 rows
    // against a ~650 norm. The gate counts ROWS; this counts VALUES. Two independent tests, and
    // this one is applied second.
    if (p.rows > 0 && p.nonZeroRows === 0) {
      excluded.push({ asOf: iso(p.start)!, rows: p.rows, reason: 'all-zero' })
      continue
    }
    if (p.rows < threshold) {
      excluded.push({ asOf: iso(p.start)!, rows: p.rows, reason: 'below-threshold' })
      continue
    }
    return {
      start: p.start,
      rows: p.rows,
      gapDays: Math.round((+chosen - +p.start) / 86_400_000),
      reason: 'comparable',
      excluded,
    }
  }
  return { start: null, rows: 0, gapDays: null, reason: 'all-older-excluded', excluded }
}

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
  // SOV.2/3/4 — the ad window, the signal narrowing, and the unbid view. Unknown values fall back.
  const adWindowDays: number = (SOV_AD_WINDOWS as readonly number[]).includes(q.adWindow ?? 0) ? q.adWindow! : SOV_DEFAULT_AD_WINDOW
  const signal: SovSignal | null = (SOV_SIGNALS as readonly string[]).includes(q.signal ?? '') ? (q.signal as SovSignal) : null
  const view: 'unbid' | null = q.view === 'unbid' ? 'unbid' : null
  const adSince = new Date(Date.now() - adWindowDays * 86_400_000)

  // ── one round trip for everything that depends only on `market` ─────────────
  // KT.1b measured this ordering as most of a 6.6s first paint when it was serial. The period
  // groupBy and both freshness probes depend on nothing but the market, so they belong here.
  const [campaigns, ads, watchlists, periodGroups, nonZeroGroups, sqpLatest, adsLatest, protections, searchTerms, biddedTargets] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, externalCampaignId: true } }),
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
    // SOV.1 — rows per period carrying a non-zero OUR-side impression count. A period where this is
    // 0 while `rows` is not is the pre-ACR.0.2 parser defect, and it must never become a Δ baseline.
    // `gt: 0` on a non-nullable Int with default 0 — no null branch to spell out.
    prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: market, impressionsBrand: { gt: 0 } }, _count: { _all: true },
    }),
    prisma.searchQueryPerformance.findFirst({ where: { marketplace: market }, orderBy: { startDate: 'desc' }, select: { startDate: true } }),
    prisma.amazonAdsSearchTerm.findFirst({ where: { marketplace: market }, orderBy: { date: 'desc' }, select: { date: true } }),
    // The same classifier KT.2 stores its per-term flag with. Never a second definition of "brand".
    prisma.adKeywordProtection.findMany({
      where: { mode: 'WHITELIST' },
      select: { term: true, matchType: true, isPrefix: true, marketplace: true },
    }),
    // SOV.2 — the AD side, fetched for the whole market and narrowed to the resolved campaigns
    // in memory (scope resolves after this round trip). The same table the legacy cockpit service
    // read; the aggregation below re-cuts its signals against MEDIANS (SOV.3).
    prisma.amazonAdsSearchTerm.findMany({
      where: { marketplace: market, date: { gte: adSince } },
      select: { query: true, campaignId: true, impressions: true, clicks: true, costMicros: true },
    }),
    // SOV.4 — every ENABLED positive keyword target in this market, for the "never bought" half
    // of unbid. One market-wide read and a Set: no per-query lookups.
    prisma.adTarget.findMany({
      where: { isNegative: false, status: 'ENABLED', expressionValue: { gt: '' }, adGroup: { campaign: { marketplace: market } } },
      select: { expressionValue: true },
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

  // ── SOV.2 — the ad side per query, scoped to the resolved campaigns ─────────────────────────
  const scopeCampaignSet = new Set(scope.campaignIds)
  // 🔴 AmazonAdsSearchTerm.campaignId is the EXTERNAL Amazon id (the schema says so in as many
  // words) — the same external-vs-local trap the placement report already charged this repo for.
  // Compared raw against local Campaign.id it matches NOTHING, and the first deploy shipped
  // "0 of 480 queries carry any ad activity" over a table with fresh rows. Resolve through
  // externalCampaignId before the scope test.
  const localByExternal = new Map<string, string>()
  for (const c of campaigns) if (c.externalCampaignId) localByExternal.set(c.externalCampaignId, c.id)
  interface AdAgg { impr: number; clicks: number; costCents: number; campaigns: Set<string> }
  const adAgg = new Map<string, AdAgg>()
  for (const t of searchTerms) {
    const localId = localByExternal.get(t.campaignId) ?? t.campaignId
    if (!scopeCampaignSet.has(localId)) continue
    const key = normTerm(t.query ?? '')
    if (!key) continue
    let a = adAgg.get(key)
    if (!a) { a = { impr: 0, clicks: 0, costCents: 0, campaigns: new Set() }; adAgg.set(key, a) }
    a.impr += t.impressions
    a.clicks += t.clicks
    a.costCents += Number(t.costMicros) / 10_000
    a.campaigns.add(localId)
  }
  const adSpendTotalCents = [...adAgg.values()].reduce((n, a) => n + a.costCents, 0)
  // SOV.3 — the signal bars, ALL medians. The legacy outbid bar compared impressions to the MEAN,
  // which 1,925 of 1,992 queries sit below; a median splits the population by construction.
  const medianAdImpr = median([...adAgg.values()].filter((a) => a.impr > 0).map((a) => a.impr))
  const medianAdCpc = median([...adAgg.values()].filter((a) => a.clicks > 0).map((a) => a.costCents / a.clicks))
  const medianAdCtr = median([...adAgg.values()].filter((a) => a.impr > 0).map((a) => a.clicks / a.impr))
  const biddedSet = new Set(biddedTargets.map((t) => normTerm(t.expressionValue ?? '')).filter(Boolean))

  /** The ad columns + signals for one query, shared by both row branches. */
  const adSideOf = (query: string): { ad: SovRow['ad']; signals: SovSignal[] } => {
    const a = adAgg.get(normTerm(query))
    if (!a) return { ad: null, signals: [] }
    const cpcCents = a.clicks > 0 ? a.costCents / a.clicks : null
    const ctr = a.impr > 0 ? a.clicks / a.impr : null
    const signals: SovSignal[] = []
    if (cpcCents != null && medianAdCpc > 0 && cpcCents > medianAdCpc * 1.25 && a.impr < medianAdImpr) signals.push('outbid')
    if (a.impr >= 50 && ctr != null && medianAdCtr > 0 && ctr < medianAdCtr * 0.5) signals.push('weak-relevance')
    if (a.campaigns.size >= 2) signals.push('cannibalized')
    return {
      ad: {
        impressions: a.impr,
        clicks: a.clicks,
        spendCents: Math.round(a.costCents),
        cpcCents: cpcCents != null ? Math.round(cpcCents) : null,
        spendShare: adSpendTotalCents > 0 ? a.costCents / adSpendTotalCents : null,
        campaigns: a.campaigns.size,
      },
      signals,
    }
  }

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
  // SOV.1 — the row shape both periods are read with. `clicksTotal/Brand` join the select for the
  // click-share column; `cartAddsBrand`/`purchasesBrand` are read ONLY to count coverage, because
  // they are far too sparse to be columns (§ funnelCoverage below).
  const ROW_SELECT = {
    searchQuery: true, asin: true,
    impressionsTotal: true, impressionsBrand: true,
    clicksTotal: true, clicksBrand: true,
    cartAddsBrand: true, purchasesBrand: true,
    searchQueryVolume: true, searchQueryRank: true,
  } as const

  const periodStats: SovPeriodStat[] = (() => {
    const nz = new Map(nonZeroGroups.map((g) => [+g.startDate, g._count._all]))
    return periodGroups.map((p) => ({
      start: p.startDate, rows: p._count._all, nonZeroRows: nz.get(+p.startDate) ?? 0,
    }))
  })()
  const prior = choosePriorPeriod(periodStats, chosen.start, chosen.threshold)

  const [marketRows, priorRows] = await Promise.all([
    chosen.start
      ? prisma.searchQueryPerformance.findMany({ where: { marketplace: market, startDate: chosen.start }, select: ROW_SELECT })
      : Promise.resolve([]),
    // The prior period is read through the SAME scope filter. A Δ between "this scope now" and
    // "the whole market last week" would be a different quantity wearing the same label.
    prior.start
      ? prisma.searchQueryPerformance.findMany({ where: { marketplace: market, startDate: prior.start }, select: ROW_SELECT })
      : Promise.resolve([]),
  ])

  const scopedAsins = new Set(scope.asins)
  interface Agg {
    total: number; brand: number; clicksTotal: number; clicksBrand: number
    cartAdds: number; purchases: number
    vol: number; rank: number | null; asins: Set<string>
  }
  const blank = (): Agg => ({
    total: 0, brand: 0, clicksTotal: 0, clicksBrand: 0, cartAdds: 0, purchases: 0,
    vol: 0, rank: null, asins: new Set<string>(),
  })
  type Row = { searchQuery: string; asin: string | null; impressionsTotal: number; impressionsBrand: number; clicksTotal: number; clicksBrand: number; cartAddsBrand: number; purchasesBrand: number; searchQueryVolume: number; searchQueryRank: number | null }
  const add = (m: Map<string, Agg>, key: string, r: Row) => {
    const a = m.get(key) ?? blank()
    // MAX, not sum: a whole-market count is repeated on every ASIN row of the query, so summing it
    // would multiply it. Verified on prod: 0 of 482 IT queries disagree across their rows.
    // Σ for our own side. SOV.0 established this rule and every numerator added here keeps it.
    a.total = Math.max(a.total, r.impressionsTotal)
    a.brand += r.impressionsBrand
    a.clicksTotal = Math.max(a.clicksTotal, r.clicksTotal)
    a.clicksBrand += r.clicksBrand
    a.cartAdds += r.cartAddsBrand
    a.purchases += r.purchasesBrand
    a.vol = Math.max(a.vol, r.searchQueryVolume)
    if (r.searchQueryRank != null) a.rank = a.rank == null ? r.searchQueryRank : Math.min(a.rank, r.searchQueryRank)
    if (r.asin) a.asins.add(r.asin)
    m.set(key, a)
  }
  const inScope = (r: Row) => !scope.asinScoped || (!!r.asin && scopedAsins.has(r.asin))

  const marketAgg = new Map<string, Agg>()
  const scopedAgg = new Map<string, Agg>()
  const priorAgg = new Map<string, Agg>()
  const asinsSeen = new Set<string>()
  for (const r of marketRows as Row[]) {
    add(marketAgg, r.searchQuery, r)
    if (r.asin) asinsSeen.add(r.asin)
    // `asinScoped` is false at market grain — KT's resolver says so, and it means "no ASIN
    // restriction on the share query at all", which is the market view by definition.
    if (inScope(r)) add(scopedAgg, r.searchQuery, r)
  }
  for (const r of priorRows as Row[]) if (inScope(r)) add(priorAgg, r.searchQuery, r)

  /** share of a stage, or null. 🔴 Never `0` for "no denominator" — that is the tie the page exists to break. */
  const shareOf = (brand: number, total: number): number | null =>
    (total > 0 ? Math.max(0, Math.min(1, brand / total)) : null)

  /**
   * The confidence floor: the MEDIAN whole-market impressions across the queries this period
   * measured. Derived from the period's own distribution rather than a magic number, so it adapts
   * per market and per week. Measured today — IT 371 · DE 290 · ES 176 · FR 313, against a median
   * of just **85** among the top 20 by share. That gap is the entire argument of the sort rule.
   */
  const confidenceFloor = median([...scopedAgg.values()].filter((a) => a.total > 0).map((a) => a.total))
  /** the same floor for the click denominator, which is two to three orders of magnitude smaller */
  const confidenceFloorClicks = median([...scopedAgg.values()].filter((a) => a.clicksTotal > 0).map((a) => a.clicksTotal))

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
      const share = shareOf(mine.brand, mine.total)
      const was = priorAgg.get(query)
      const priorShare = was ? shareOf(was.brand, was.total) : null
      // A prior ROW that carries no market total is not a prior VALUE — it cannot anchor a Δ, so it
      // is `delta-no-prior` exactly like a missing row. Both are "nothing to compare against".
      const comparable = share != null && priorShare != null
      const adSide = adSideOf(query)
      return {
        query, marketplace: market,
        marketVolume: mine.vol, marketRank: mine.rank,
        marketImpressions: mine.total, ourImpressions: mine.brand,
        share,
        marketClicks: mine.clicksTotal, ourClicks: mine.clicksBrand,
        clickShare: shareOf(mine.clicksBrand, mine.clicksTotal),
        priorShare,
        // PERCENTAGE POINTS. 1.71% → 1.83% is +0.12, never "+7%".
        deltaPt: comparable ? (share - priorShare) * 100 : null,
        deltaState: comparable ? 'delta-measured' : 'delta-no-prior',
        lowConfidence: mine.total > 0 && mine.total < confidenceFloor,
        lowConfidenceClicks: mine.clicksTotal > 0 && mine.clicksTotal < confidenceFloorClicks,
        asinsCompeting: mine.asins.size,
        state: 'measured', lastSeen: null, lastSeenAgeDays: null,
        branded, asinLike, onList,
        ad: adSide.ad,
        signals: adSide.signals,
        // SOV.4 — presence with no ad activity and no keyword target. `brand > 0`, not `share`,
        // because a null share (no market total) can still carry real appearances.
        unbid: mine.brand > 0 && adSide.ad == null && !biddedSet.has(normTerm(query)),
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
      ourImpressions: null, share: null,
      marketClicks: mkt ? mkt.clicksTotal : null, ourClicks: null, clickShare: null,
      // Nothing measured this period ⇒ nothing to compare. Distinct from `delta-no-prior`, which
      // means "we ARE measured now and there is no prior" — a fact about the baseline, not the row.
      priorShare: null, deltaPt: null, deltaState: 'delta-not-applicable',
      lowConfidence: false, lowConfidenceClicks: false,
      asinsCompeting: 0,
      state, lastSeen: iso(seen), lastSeenAgeDays: ageDays(seen),
      branded, asinLike, onList,
      // A query with no SQP presence can still be BOUGHT — the ad side renders on blank rows too,
      // which is how "we spend on this and Brand Analytics never shows us" becomes visible.
      ...adSideOf(query),
      unbid: false,
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
    /** the Δ's own axis — see SovDeltaState. 18–28% of rows have a prior; one view has none. */
    deltaMeasured: filtered.filter((r) => r.deltaState === 'delta-measured').length,
    deltaNoPrior: filtered.filter((r) => r.deltaState === 'delta-no-prior').length,
    /** rows whose market denominator is below the period's median — too small to rank */
    lowConfidence: filtered.filter((r) => r.lowConfidence).length,
    lowConfidenceClicks: filtered.filter((r) => r.lowConfidenceClicks).length,
    // SOV.3/4 — counted BEFORE the signal/view narrowing (their own dimension), so each chip
    // advertises exactly what turning it on would show.
    outbid: filtered.filter((r) => r.signals.includes('outbid')).length,
    weakRelevance: filtered.filter((r) => r.signals.includes('weak-relevance')).length,
    cannibalized: filtered.filter((r) => r.signals.includes('cannibalized')).length,
    unbid: filtered.filter((r) => r.unbid).length,
    /** rows carrying any ad activity in the ad window — the ad columns' own denominator */
    withAdActivity: filtered.filter((r) => r.ad != null).length,
  }

  // SOV.3/4 — the GRID narrows; the census, the band and the scope Δ above keep describing the
  // SCOPE. A signal chip's count and its result share one predicate by construction.
  const gridRows = filtered.filter((r) =>
    (signal == null || r.signals.includes(signal)) && (view !== 'unbid' || r.unbid))

  const measured = filtered.filter((r) => r.state === 'measured' && r.share !== null)

  /**
   * 🔴 THE SCOPE-LEVEL Δ — computed over the INTERSECTION only, and it says so.
   *
   * An intersection is not a filter. Comparing "this week's total share" against "last week's total
   * share" over two different query populations is the KT.1b population-mixing defect at aggregate
   * level: it produces a headline number that moves when nothing changed. Only queries measured in
   * BOTH periods, within THIS scope, enter either side of this ratio.
   *
   * Aggregated the way the whole page aggregates — `brand = Σ`, `total = max` per query — then both
   * summed across the intersection and divided ONCE. Never an average of per-row percentages: that
   * is the unweighted/weighted trap, and on this data the two answers differ by ~8×.
   */
  const scopeDelta = (() => {
    const inBoth = measured.filter((r) => r.deltaState === 'delta-measured')
    if (!prior.start || !inBoth.length) {
      return {
        queries: 0,
        nowShare: null as number | null,
        priorShare: null as number | null,
        deltaPt: null as number | null,
        withoutPrior: measured.length,
      }
    }
    let nowBrand = 0, nowTotal = 0, wasBrand = 0, wasTotal = 0
    for (const r of inBoth) {
      const was = priorAgg.get(r.query)!
      nowBrand += r.ourImpressions ?? 0
      nowTotal += r.marketImpressions ?? 0
      wasBrand += was.brand
      wasTotal += was.total
    }
    const nowShare = shareOf(nowBrand, nowTotal)
    const priorShare = shareOf(wasBrand, wasTotal)
    return {
      queries: inBoth.length,
      nowShare,
      priorShare,
      deltaPt: nowShare != null && priorShare != null ? (nowShare - priorShare) * 100 : null,
      withoutPrior: measured.length - inBoth.length,
    }
  })()

  /**
   * The one pair of numbers the band carries, and they must always appear together.
   *
   * `weighted` = Σ our impressions ÷ Σ market impressions across the view — our share of all the
   * demand this view can see. `medianQuery` = the median of the per-row shares. Measured today the
   * weighted figure is ~8× SMALLER, and the gap IS the finding: **we hold a few percent of hundreds
   * of tiny queries and almost nothing of the big ones.** Showing only the median would flatter this
   * account by an order of magnitude, which is why neither ships alone.
   */
  const shareSummary = (() => {
    const totalMkt = measured.reduce((n, r) => n + (r.marketImpressions ?? 0), 0)
    const totalOurs = measured.reduce((n, r) => n + (r.ourImpressions ?? 0), 0)
    return {
      queries: measured.length,
      ourImpressions: totalOurs,
      marketImpressions: totalMkt,
      weighted: shareOf(totalOurs, totalMkt),
      medianQuery: measured.length ? median(measured.map((r) => r.share!)) : null,
    }
  })()

  /**
   * Why cart-add share and purchase share are NOT columns.
   *
   * Measured in the default view: our-side cart-adds exist on **14 of 482** IT queries (2.9%) and
   * purchases on **1** (0.2%); ES has 4 and **0**; FR has 0 and 0. Two columns that are `—` on 97%+
   * of rows are two promises the data cannot keep — *an empty column is a promise, a missing column
   * is a decision* (KT.1's law). This is NOT the parser defect: clicks parse fine in the same rows
   * (475 of 482 in IT), so cart-adds and purchases are genuinely sparse at query × ASIN × week
   * grain. They are stated as coverage and belong in the row drawer (SOV.5).
   */
  const funnelCoverage = {
    queries: measured.length,
    clicks: measured.filter((r) => (r.ourClicks ?? 0) > 0).length,
    cartAdds: filtered.filter((r) => (scopedAgg.get(r.query)?.cartAdds ?? 0) > 0).length,
    purchases: filtered.filter((r) => (scopedAgg.get(r.query)?.purchases ?? 0) > 0).length,
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
      case 'clickShare': return s * ((a.clickShare ?? -1) - (b.clickShare ?? -1))
      case 'delta': return s * ((a.deltaPt ?? Number.NEGATIVE_INFINITY) - (b.deltaPt ?? Number.NEGATIVE_INFINITY))
      case 'asins': return s * (a.asinsCompeting - b.asinsCompeting)
      case 'adSpend': return s * ((a.ad?.spendCents ?? -1) - (b.ad?.spendCents ?? -1))
      case 'volume':
      default: return s * ((a.marketVolume ?? -1) - (b.marketVolume ?? -1))
    }
  }
  // Measured rows first regardless of direction — a blank has nothing to sort BY, and sorting it to
  // the top of a share column reads as "worst performer". Between the blanks: a query the market
  // has but our ASINs are not covered on is a coverage gap you can chase; one the feed reported in
  // another week is a staleness fact; one it has never reported is neither.
  const stateRank = (r: SovRow) => (r.state === 'measured' ? 0 : r.state === 'not-covered' ? 1 : r.state === 'no-row-this-period' ? 2 : 3)
  /**
   * 🔴 THE SORT DISCIPLINE. Sorting by a share must not rank noise first.
   *
   * Measured on IT 2026-07-19, share-descending: the top of the page is
   * `sappnetta knee spider nero` at **50.00% of 4 market impressions**, followed by five typos.
   * Meanwhile the five queries above 10% share carry **221 of 1,671,561 market impressions —
   * 0.01% of the demand** the page is about, while the 313 queries above 1% carry 29.18%.
   *
   * Nothing is hidden — hiding data is not the fix. Rows whose denominator is below the period's
   * median sink BELOW confident rows within the same direction, and say why on hover. This applies
   * to the share sorts only: sorting by market volume or rank is already denominator-aware, and
   * demoting rows there would be inventing a second opinion about the operator's own request.
   */
  const confidenceSort = sortKey === 'share' || sortKey === 'clickShare' || sortKey === 'delta'
  const sorted = [...gridRows].sort((a, b) => {
    const ra = stateRank(a), rb = stateRank(b)
    if (ra !== rb) return ra - rb
    // Each share sorts by ITS OWN denominator's confidence — the click floor is two to three
    // orders of magnitude below the impression floor, so one flag would police the wrong column.
    if (confidenceSort) {
      const la = sortKey === 'clickShare' ? a.lowConfidenceClicks : a.lowConfidence
      const lb = sortKey === 'clickShare' ? b.lowConfidenceClicks : b.lowConfidence
      if (la !== lb) return la ? 1 : -1
    }
    return cmp(a, b)
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
      /**
       * SOV.1 — the week a Δ is measured against, and everything the page needs to name it.
       * `gapDays` is NOT always 7: at `?market=ES&weeks=4` the chosen period is 2026-07-26 and the
       * nearest comparable prior is 2026-07-12. The page must render the date, not "last week".
       */
      prior: {
        asOf: iso(prior.start),
        ageDays: ageDays(prior.start),
        rows: prior.rows,
        gapDays: prior.gapDays,
        reason: prior.reason,
      },
      /** older periods skipped, and why — the all-zero ones are the parser defect, COMPUTED */
      excludedPeriods: prior.excluded,
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
    /** the scope-level Δ, over the intersection only, always honest — see `scopeDelta` above */
    scopeDelta,
    /** the weighted / median pair. Neither ever ships alone; the gap between them is the finding. */
    shareSummary,
    /** why cart-add and purchase share are a stated line rather than two permanently empty columns */
    funnelCoverage,
    /** the median market impressions this period; rows below it cannot be ranked by share */
    confidenceFloor,
    confidenceFloorClicks,
    facets,
    rows: page,
    /** the GRID's total after the signal/view narrowing; the census states the pre-narrowed set */
    total: gridRows.length,
    /** SOV.2 — the ad columns' own window, so the header can label them with it */
    adWindowDays,
    signal,
    view,
  }
}

/**
 * SOV.5 — the row drawer's read: one query in one market, through the page's scope.
 *
 * Owns what SOV.1 §9 moved here: the weekly SERIES (every period, not just the chosen one, each
 * with its all-zero parser flag so the drawer never plots a fake collapse), CART-ADD and PURCHASE
 * share (2.9% and 0.2% row coverage made them drawer facts, not columns), WHICH ASIN holds the
 * term, and the campaigns buying it — from the ad side (observed) and the keyword targets
 * (declared), stated apart because a declared bid that never serves is its own finding.
 */
export async function getSovRowDetail(args: {
  query: string
  market: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
}) {
  const { query, market } = args
  const [campaigns, ads, sqpRows, searchTerms, targets] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, externalCampaignId: true } }),
    prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: market } } },
      select: { productId: true, asin: true, adGroup: { select: { campaignId: true } } },
    }),
    prisma.searchQueryPerformance.findMany({
      where: { marketplace: market, searchQuery: query },
      select: {
        startDate: true, asin: true,
        impressionsTotal: true, impressionsBrand: true,
        clicksTotal: true, clicksBrand: true,
        cartAddsTotal: true, cartAddsBrand: true,
        purchasesTotal: true, purchasesBrand: true,
        searchQueryVolume: true,
      },
    }),
    prisma.amazonAdsSearchTerm.findMany({
      where: { marketplace: market, date: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      select: { query: true, campaignId: true, impressions: true, clicks: true, costMicros: true },
    }),
    prisma.adTarget.findMany({
      where: { isNegative: false, status: 'ENABLED', expressionValue: { gt: '' }, adGroup: { campaign: { marketplace: market } } },
      select: { expressionValue: true, expressionType: true, bidCents: true, adGroup: { select: { campaign: { select: { id: true, name: true } } } } },
    }),
  ])

  const productIds = [...new Set(ads.map((a) => a.productId).filter((x): x is string => !!x))]
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true } })
    : []
  const graph: KtScopeGraph = {
    campaigns: campaigns.map((c) => ({ ...c, status: String(c.status) })),
    ads: ads.filter((a) => a.adGroup?.campaignId).map((a) => ({ productId: a.productId, asin: a.asin, campaignId: a.adGroup!.campaignId })),
    products,
  }
  const scope = resolveScope(graph, { market, line: args.line, portfolio: args.portfolio, campaign: args.campaign })
  const scopedAsins = new Set(scope.asins)
  const inScope = (asin: string | null) => !scope.asinScoped || (!!asin && scopedAsins.has(asin))

  // ── the weekly series, oldest → newest, with the parser flag per period ──
  interface P { total: number; brand: number; clicksTotal: number; clicksBrand: number; cartAddsTotal: number; cartAdds: number; purchasesTotal: number; purchases: number; vol: number; periodNonZero: boolean }
  const byPeriod = new Map<number, P>()
  for (const r of sqpRows) {
    if (!inScope(r.asin)) continue
    const k = +r.startDate
    let p = byPeriod.get(k)
    if (!p) { p = { total: 0, brand: 0, clicksTotal: 0, clicksBrand: 0, cartAddsTotal: 0, cartAdds: 0, purchasesTotal: 0, purchases: 0, vol: 0, periodNonZero: false }; byPeriod.set(k, p) }
    // Same MAX/Σ rule as the grid — whole-market counts repeat on every ASIN row.
    p.total = Math.max(p.total, r.impressionsTotal)
    p.brand += r.impressionsBrand
    p.clicksTotal = Math.max(p.clicksTotal, r.clicksTotal)
    p.clicksBrand += r.clicksBrand
    p.cartAddsTotal = Math.max(p.cartAddsTotal, r.cartAddsTotal)
    p.cartAdds += r.cartAddsBrand
    p.purchasesTotal = Math.max(p.purchasesTotal, r.purchasesTotal)
    p.purchases += r.purchasesBrand
    p.vol = Math.max(p.vol, r.searchQueryVolume)
  }
  // The all-zero parser weeks are flagged per MARKET period (a query's own zero week is real when
  // the market period parsed). One groupBy answers it for every period at once.
  const nonZero = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate'], where: { marketplace: market, impressionsBrand: { gt: 0 } }, _count: { _all: true },
  })
  const nonZeroSet = new Set(nonZero.map((g) => +g.startDate))
  const share = (b: number, t: number): number | null => (t > 0 ? Math.max(0, Math.min(1, b / t)) : null)
  const series = [...byPeriod.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, p]) => ({
      asOf: new Date(k).toISOString().slice(0, 10),
      share: share(p.brand, p.total),
      clickShare: share(p.clicksBrand, p.clicksTotal),
      cartAddShare: share(p.cartAdds, p.cartAddsTotal),
      purchaseShare: share(p.purchases, p.purchasesTotal),
      ourImpressions: p.brand,
      marketImpressions: p.total,
      marketVolume: p.vol,
      /** false = the pre-ACR.0.2 parser defect week: OUR side reads 0 market-wide. Never plot as a collapse. */
      periodParsed: nonZeroSet.has(k),
    }))

  // ── which ASIN holds the term, newest period ──
  const newest = series.length ? series[series.length - 1].asOf : null
  const holders = newest
    ? sqpRows
      .filter((r) => r.startDate.toISOString().slice(0, 10) === newest && inScope(r.asin) && r.asin)
      .map((r) => ({ asin: r.asin!, ourImpressions: r.impressionsBrand, ourClicks: r.clicksBrand }))
      .sort((a, b) => b.ourImpressions - a.ourImpressions)
    : []

  // ── the campaigns buying it: observed (search terms, 30d) vs declared (enabled targets) ──
  const nq = normTerm(query)
  const campName = new Map(campaigns.map((c) => [c.id, c.name] as const))
  // Same external-vs-local resolution as the grid's ad join — the schema calls this column an
  // external Amazon id.
  const rowLocalByExternal = new Map<string, string>()
  for (const c of campaigns) if (c.externalCampaignId) rowLocalByExternal.set(c.externalCampaignId, c.id)
  const observed = new Map<string, { impressions: number; clicks: number; spendCents: number }>()
  for (const t of searchTerms) {
    if (normTerm(t.query ?? '') !== nq) continue
    const localId = rowLocalByExternal.get(t.campaignId) ?? t.campaignId
    const o = observed.get(localId) ?? { impressions: 0, clicks: 0, spendCents: 0 }
    o.impressions += t.impressions
    o.clicks += t.clicks
    o.spendCents += Number(t.costMicros) / 10_000
    observed.set(localId, o)
  }
  const declared = targets
    .filter((t) => normTerm(t.expressionValue ?? '') === nq && t.adGroup?.campaign)
    .map((t) => ({ campaignId: t.adGroup!.campaign!.id, campaign: t.adGroup!.campaign!.name, match: t.expressionType, bidCents: t.bidCents }))

  return {
    query,
    market,
    scope: { boundBy: scope.boundBy, asins: scope.asins.length, asinScoped: scope.asinScoped },
    series,
    holders,
    buying: {
      observed: [...observed.entries()]
        .map(([id, o]) => ({ campaignId: id, campaign: campName.get(id) ?? id, ...o, spendCents: Math.round(o.spendCents) }))
        .sort((a, b) => b.spendCents - a.spendCents),
      declared,
    },
  }
}
