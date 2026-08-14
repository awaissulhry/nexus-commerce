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

/**
 * KT.8 — how many of OUR ASINs a period must have measured to qualify. **This replaces the ratio for
 * every caller that supplies coverage; it is not OR'd with it and not AND'd with it.**
 *
 * ── Why the ratio had to go ───────────────────────────────────────────────────────────────────
 *
 * `SQP_COMPLETENESS_RATIO` compares a week's row count against the median of the weeks around it. That
 * was right when every stored week came from the same backfill. It is wrong now, in both directions:
 *
 *   • **Too strict today.** The baseline still holds backfill weeks (07-12 = 1,066 IT rows) while a
 *     cron-fed week produces 135–258, so IT needed 279.25 and had 258 — short by **21 rows, 7.6%** —
 *     and the page read a **27-day-old** week while the feed underneath it got better.
 *   • **🔴 Too loose tomorrow.** Once the backfill weeks age out, the baseline is a median of cron
 *     weeks and the threshold is set by the very thinness it exists to catch. Measured on a cron-only
 *     baseline: IT 4.0 · DE 2.5 · ES 35.5 · **FR 0.5, against a week holding one row.** Every week
 *     passes by construction. **A threshold defined as a fraction of a statistic over the same
 *     population it judges will eventually pass everything.**
 *
 * A fixed floor cannot go vacuous, because it is not computed from our own output. SQP.4 checked the
 * obvious alternative and it fails the same way: ASIN coverage compared against its OWN median
 * collapses identically, since coverage is bounded by how many ASINs we request. The fix is the fixed
 * reference, not the change of quantity.
 *
 * ── Why 5 ─────────────────────────────────────────────────────────────────────────────────────
 *
 * `SQP_ASINS_PER_MARKET` is 10: the nightly pass asks about ten ASINs per market. **A week that
 * measured fewer than half the ASINs we asked about is a sample, not a week.** That ties the constant
 * to a real one rather than to the outcome it produces.
 *
 * Measured 2026-08-14 — 3, 5 and 8 all put IT, DE and ES on 2026-08-02, so the choice only decides how
 * fast a degrading market is refused. 8 leaves DE (10 covered) two of headroom and is brittle to normal
 * variation; 3 would keep FR on a three-ASIN week, which renders a share that looks real and is not.
 *
 * ── Why coverage and not rows ─────────────────────────────────────────────────────────────────
 *
 * Rows scale with how many search queries each ASIN happens to match, so they are not comparable across
 * weeks or markets. **ASINs measured is what the page's own reach line already prints**, so the gate
 * and the caption finally describe the same quantity.
 */
export const KT_COVERAGE_FLOOR = 5

/**
 * KT.10 — Amazon's hard ceiling on how many search queries one report returns for one ASIN in one week.
 *
 * Measured 2026-08-15 across **395** distinct (market, week, ASIN) cells: **none above 100, 70 at
 * exactly 100.** That is what bounds terms covered — not the number of ASINs, which is why SQP.5
 * measured ten ASINs buying all 97 IT watchlist terms while ASINs 11–15 bought zero.
 *
 * It belongs on the page because the reach line's denominator ("12 of 250 advertised ASINs") implies
 * the fix is more ASINs. Ten measured ASINs is already 1,000 query slots against a 97-term watchlist.
 */
export const SQP_QUERIES_PER_ASIN_CAP = 100

/** How many recent periods define "a normal week here". A quarter of weekly history. */
export const SQP_BASELINE_PERIODS = 12

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const KT_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

export type KtGrain = 'market' | 'line' | 'portfolio' | 'campaign'
export type KtMeasuredFilter = 'all' | 'yes' | 'no'
export type KtSortKey = 'keyword' | 'volume' | 'rank' | 'share' | 'asins' | 'asOf' | 'delta' | 'spend'

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
export interface KtPeriodCandidate {
  start: Date
  rows: number
  /** distinct ASINs of ours measured in this period, for this market. Absent for callers still on the
   *  row ratio — Share of Voice is one, deliberately. */
  asins?: number
}

export type KtPeriodReason = 'complete' | 'incomplete-week' | 'outside-lookback' | 'no-data'

export interface KtChosenPeriod {
  start: Date | null
  /** distinct ASINs measured in the chosen period — the number the reach line prints */
  asins: number
  /** the floor that was applied, or null when this caller is still on the row ratio */
  floorAsins: number | null
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
/**
 * KT.8 — distinct ASINs of ours measured per period, for one market.
 *
 * `groupBy` cannot express `count(DISTINCT asin)`, so this is raw. **Exported and shared on purpose:**
 * the grid, the cliff projection, the term drawer and KT.6's proposals all gate on the same week, and
 * KT.7 already paid for two surfaces computing the same thing separately. The `where` here mirrors the
 * period groupBy exactly (`marketplace` only, no `reportPeriod` filter) — if those two ever disagree,
 * the gate is judging a different population from the one it is counting.
 */
export async function periodCoverageByMarket(market: string): Promise<Map<number, number>> {
  const rows = await prisma.$queryRaw<Array<{ startDate: Date; n: number }>>`
    SELECT "startDate", count(DISTINCT "asin")::int AS n
    FROM "SearchQueryPerformance"
    WHERE "marketplace" = ${market} AND "asin" IS NOT NULL
    GROUP BY 1`
  return new Map(rows.map((r) => [+r.startDate, Number(r.n)]))
}

export function chooseViewPeriod(
  periods: KtPeriodCandidate[],
  opts: { lookbackDays?: number; ratio?: number; baselinePeriods?: number; now?: number; floorAsins?: number } = {},
): KtChosenPeriod {
  const lookbackDays = opts.lookbackDays ?? KT_LOOKBACK_DAYS
  const ratio = opts.ratio ?? SQP_COMPLETENESS_RATIO
  const baselinePeriods = opts.baselinePeriods ?? SQP_BASELINE_PERIODS
  const now = opts.now ?? Date.now()
  // 🔴 Opt-in PER CALLER, and that is the whole boundary. A caller that supplies `floorAsins` gets the
  // floor INSTEAD of the ratio; one that does not keeps the ratio untouched. Share of Voice calls this
  // same function from another page, so a global switch would have moved a surface this session does
  // not own. Absence is not a fallback for the KT path — every KT call site passes it explicitly.
  const floorAsins = opts.floorAsins ?? null

  const sorted = [...periods].sort((a, b) => +b.start - +a.start)
  if (!sorted.length) {
    return { start: null, asins: 0, floorAsins, rows: 0, baselineRows: 0, threshold: 0, reason: 'no-data', truncated: true, rejected: [] }
  }

  const baselineRows = median(sorted.slice(0, baselinePeriods).map((p) => p.rows))
  // Kept and still reported even under the floor: the health line explains WHY a week was refused, and
  // "258 rows where a normal week holds 558" is the sentence that makes the feed's state legible.
  const threshold = ratio * baselineRows
  const inLookback = sorted.filter((p) => (now - +p.start) / 86_400_000 <= lookbackDays)

  // A missing `asins` scores 0 rather than passing — no evidence is not the same as enough evidence.
  const qualifies = (p: KtPeriodCandidate) =>
    floorAsins === null ? p.rows >= threshold : (p.asins ?? 0) >= floorAsins

  const rejected: Array<{ start: string; rows: number }> = []
  for (const p of inLookback) {
    if (qualifies(p)) {
      return { start: p.start, asins: p.asins ?? 0, floorAsins, rows: p.rows, baselineRows, threshold, reason: 'complete', truncated: false, rejected }
    }
    rejected.push({ start: iso(p.start)!, rows: p.rows })
  }

  // Nothing qualified. Render the newest thing we have rather than an empty page — and say so.
  // Two different failures, because they need different sentences: the newest week inside the
  // window is partial, versus there is no week inside the window at all.
  const fallback = inLookback[0] ?? sorted[0]
  return {
    start: fallback.start,
    asins: fallback.asins ?? 0,
    floorAsins,
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
/**
 * KT.5 — when does this view stop being current, as a DATE?
 *
 * "17 days old" as a caption tells an operator nothing they can act on. A named day does. Pure and
 * separate so it can be tested against a fixed clock, and because the answer is not obvious: the gate
 * never renders an empty grid, so there are TWO dates, and the FIRST is the one that matters.
 *
 *   collapseOn — the day the chosen period ages out of the lookback and the gate falls back to a
 *                thinner week. The grid does not empty; it collapses to whatever that week holds,
 *                loudly labelled. Measured today: IT and DE 2026-08-31 (IT drops to 2 of 97 terms,
 *                DE to 0 of 21); ES and FR 2026-08-24 (ES 3 of 7, FR 0 of 8).
 *   blankOn    — the day no period is inside the lookback at all. All four markets: 2026-09-07.
 *
 * Both assume the feed writes no further complete week. If one lands, both dates move forward.
 */
export function projectCliff(
  periods: KtPeriodCandidate[],
  opts: { lookbackDays?: number; ratio?: number; baselinePeriods?: number; now?: number; horizonDays?: number; floorAsins?: number } = {},
): { collapseOn: string | null; collapseToPeriod: string | null; collapseToRows: number; blankOn: string | null } {
  const now = opts.now ?? Date.now()
  const horizon = opts.horizonDays ?? 200
  const today = new Date(now); today.setUTCHours(0, 0, 0, 0)
  const base = chooseViewPeriod(periods, { ...opts, now: +today })
  let collapseOn: string | null = null
  let collapseToPeriod: string | null = null
  let collapseToRows = 0
  let blankOn: string | null = null
  for (let d = 1; d <= horizon; d++) {
    const when = +today + d * 86_400_000
    const c = chooseViewPeriod(periods, { ...opts, now: when })
    if (!collapseOn && (+(c.start ?? 0) !== +(base.start ?? 0) || c.reason !== base.reason)) {
      collapseOn = iso(new Date(when))
      collapseToPeriod = iso(c.start)
      // free: the fallback week's row count is already in the candidate list, so the sentence can
      // say "falls back to a week holding 8 rows against a normal 655" without another query
      collapseToRows = c.rows
    }
    if (c.reason === 'outside-lookback') { blankOn = iso(new Date(when)); break }
  }
  return { collapseOn, collapseToPeriod, collapseToRows, blankOn }
}

export type KtRowState =
  /** a row in the view's period — the only state that carries a share */
  | 'measured'
  /** the feed has this term in this market, but not in the period this view renders */
  | 'no-row-this-period'
  /** the feed has never reported this term in this market, at any period */
  | 'never-measured'
  /**
   * KT.5 — the feed DOES report this term in this period, but for none of the ASINs in the current
   * scope. Invisible before KT.5 because the scope filter and the measurement were one query, so
   * "no row" and "no covered ASIN of yours" collapsed. Measured: 0 instances at market scope in all
   * four markets — and **72 of 97** under campaign `Gale Jacket Yellow Only`, every one of which the
   * page was calling "no row this week" or "never measured".
   */
  | 'not-measurable-here'

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
  /** KT.5 — WHICH of our ASINs the share is attributed to. The share is one ASIN's, not a family's. */
  bestAsin: string | null
  /**
   * KT.5 — the sum of our ASINs' shares on this query, when more than one holds a row.
   * 🔴 An UPPER BOUND, never a total: two of our ASINs can appear in one search, so the addends
   * overlap. Measured across all four markets: 0 rows exceed 100%, largest ratio 4.05× (ES
   * `chaqueta moto hombre invierno`, 0.37% → 1.50% over 6 ASINs). Never label it "our total share".
   */
  shareBound: number | null
  /**
   * KT.5 — do we actually advertise on this term, and does the feed cover the ASINs that do?
   * `bestAsinAdvertisesTerm: false` is the attribution hazard: the share on screen comes from a
   * product that is in none of the ad groups bidding the term. Measured: 7 such rows across the
   * four markets, and 24 rows where ad coverage is 0.
   */
  ad: { bidOnTerm: boolean; adAsins: number; coveredAdAsins: number; bestAsinAdvertisesTerm: boolean } | null
  /**
   * KT.3 — the change in our best ASIN's share since the previous period that holds this term, in
   * PERCENTAGE POINTS (0.0031 = +0.31pp), plus how far apart the two periods actually are.
   *
   * 🔴 `deltaGapDays` is not decoration. Measured 2026-08-12: of 96 computable Δs, 9 span 14–35 days
   * (IT 3×14d, 2×28d, 4×35d; DE 1×35d; ES 2×28d). Labelling those "vs last week" would be the exact
   * defect class this page keeps removing, so the gap travels with the number and the UI prints it.
   * Null when the term has no earlier period at all — 19 of 97 in IT.
   */
  deltaPP: number | null
  /**
   * KT.10 — how the MARKET moved over the same two periods, in percent.
   *
   * 🔴 A share Δ without this is ambiguous in the way that matters: **+0.19 pp reads as "we improved"
   * when it can equally mean "the market shrank underneath us"** — and right now it is mostly the
   * second. Measured 2026-08-15, IT like-for-like 07-12 → 08-02: market volume **−46 %** while our
   * impressions fell only 10 %, so our share rose 0.296 % → 0.490 %. Good news, different fact.
   */
  marketDeltaPct: number | null
  deltaGapDays: number | null
  priorShare: number | null
  priorPeriod: string | null
  /**
   * KT.3 — ad spend on this exact query text, in the SAME week the share is measured, in cents.
   * `AmazonAdsSearchTerm` has no ASIN column, so this is spend on the TERM while the share beside it
   * is one ASIN's — the row must not imply they describe the same subject.
   * `orders` rides along in the payload but is NOT a column: measured, the share week holds 2 orders
   * in IT, 6 in DE, 1 in ES, 0 in FR — nine non-zero cells in the whole product.
   */
  spendCents: number | null
  clicks: number | null
  orders: number | null
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

/**
 * KT.3 — order two possibly-null numbers so that NULLS COME LAST whichever way the column is sorted.
 * `dir` is +1 for ascending, -1 for descending, and is applied only to the two present values.
 */
export function nullsLast(a: number | null, b: number | null, dir: number): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return dir * (a - b)
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
  const [campaigns, ads, watchlists, periodGroups, activeListingCount, sqpLatest, stLatest, plLatest, ingestDays, recentRuns] = await Promise.all([
    // KT.1b — `status` joins the select so an ARCHIVED campaign stops inflating the market's
    // campaign count (1 of IT's 150 is archived). See `resolveScope`: it is excluded from the
    // market set but still resolvable by an explicit ?campaign= pick, because the campaign picker
    // is fed by /advertising/scope-options, which is another session's route and unfiltered.
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, externalCampaignId: true } }),
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
    // KT.8 — how many listings this market has ACTIVE. FR has zero, which is the root of its
    // coverage never reaching the floor; the refusal banner names it so the operator is sent to
    // listing sync rather than to the Brand Analytics feed.
    prisma.channelListing.count({ where: { channel: 'AMAZON', listingStatus: 'ACTIVE', OR: [{ marketplace: market }, { region: market }] } }),
    prisma.searchQueryPerformance.findFirst({
      where: { marketplace: market }, orderBy: { startDate: 'desc' }, select: { startDate: true },
    }),
    prisma.amazonAdsSearchTerm.findFirst({ where: { marketplace: market }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.amazonAdsPlacementReport.findFirst({
      where: { marketplace: market, topOfSearchIS: { not: null } }, orderBy: { date: 'desc' }, select: { date: true },
    }),
    // KT.5 feed health — global, identical for every market and scope, and dependent on nothing.
    // It belongs in this batch; as two later serial reads it cost two round trips per request.
    prisma.$queryRawUnsafe<Array<{ day: string; rows: bigint }>>(
      `select to_char("ingestedAt",'YYYY-MM-DD') as day, count(*)::bigint as rows
       from "SearchQueryPerformance" where "ingestedAt" > now() - interval '14 days' group by 1 order by 1 desc`,
    ),
    prisma.cronRun.findMany({
      where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 8,
      select: { startedAt: true, status: true, errorMessage: true, outputSummary: true },
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
  // KT.8 — the candidates now carry coverage, and the gate is the FLOOR rather than the row ratio.
  // Built once and reused by `projectCliff` below: two lists would be two answers to "which week".
  const coverage = await periodCoverageByMarket(market)
  const periodCandidates: KtPeriodCandidate[] = periodGroups.map((p) => ({
    start: p.startDate, rows: p._count._all, asins: coverage.get(+p.startDate) ?? 0,
  }))
  const chosen = chooseViewPeriod(periodCandidates, { floorAsins: KT_COVERAGE_FLOOR })
  const bestAsinsInWindow = Math.max(0, ...periodCandidates
    .filter((p) => (Date.now() - +p.start) / 86_400_000 <= KT_LOOKBACK_DAYS)
    .map((p) => p.asins ?? 0))

  // ── the share rows AND the ad graph, in one round ──
  // KT.5 added the per-term ad-coverage read. Left serial it cost ~2s of a 4.5s first paint; neither
  // query depends on the other's result, so they go together.
  const [sqpRows, adTargets, priorRows, spendRows] = await Promise.all([
    visibleTerms.length && chosen.start
      ? prisma.searchQueryPerformance.findMany({
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
      : Promise.resolve([]),
    visibleTerms.length
      ? prisma.adTarget.findMany({
        where: {
          isNegative: false,
          expressionType: { in: ['EXACT', 'PHRASE', 'BROAD'] },
          expressionValue: { in: visibleTerms },
          adGroup: { campaign: { marketplace: market, ...(scope.boundBy === 'market' ? {} : { id: { in: scope.campaignIds } }) } },
        },
        select: { expressionValue: true, adGroupId: true },
      })
      : Promise.resolve([]),
    // KT.3 · Δ — every row for these terms in a period EARLIER than the chosen one. Reduced to
    // newest-per-term in JS; per-term "newest before X" is not expressible as one Prisma query, and
    // one read of ~1,500 rows beats 97 round trips.
    visibleTerms.length && chosen.start
      ? prisma.searchQueryPerformance.findMany({
        where: {
          marketplace: market,
          startDate: { lt: chosen.start },
          searchQuery: { in: visibleTerms },
          ...(scope.asinScoped ? { asin: { in: scope.asins } } : {}),
        },
        // KT.10 — `searchQueryVolume` joins the select so the share Δ can carry its DENOMINATOR.
        // It is per (query, week) and independent of ASIN, so comparing it for the same term across
        // the same two periods the Δ already uses is like-for-like by construction.
        select: { searchQuery: true, startDate: true, impressionShare: true, searchQueryVolume: true },
      })
      : Promise.resolve([]),
    // KT.3 · spend on the exact query text, in the SAME week the share is measured
    visibleTerms.length && chosen.start
      ? prisma.amazonAdsSearchTerm.groupBy({
        by: ['query'],
        where: {
          marketplace: market,
          query: { in: visibleTerms },
          date: { gte: chosen.start, lte: new Date(+chosen.start + 6 * 86_400_000) },
        },
        _sum: { costMicros: true, clicks: true, orders7d: true },
      })
      : Promise.resolve([]),
  ])

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
  /**
   * KT.5 — the third blank state needs the SAME question asked WITHOUT the ASIN filter. Before this,
   * the scope filter and the measurement were one query, so "the feed has no row for this term" and
   * "the feed has a row but not for any ASIN you are scoped to" were indistinguishable. Measured: 0
   * instances at market scope, **72 of 97** under one campaign. Only asked when the scope actually
   * restricts ASINs — at market scope the two questions are the same question.
   */
  const coveredElsewhere = new Set<string>()
  if (blankTerms.length) {
    const [seen, anyAsin] = await Promise.all([
      prisma.searchQueryPerformance.groupBy({
        by: ['searchQuery'],
        where: {
          marketplace: market,
          searchQuery: { in: blankTerms },
          ...(scope.asinScoped ? { asin: { in: scope.asins } } : {}),
        },
        _max: { startDate: true },
      }),
      scope.asinScoped && chosen.start
        ? prisma.searchQueryPerformance.groupBy({
          by: ['searchQuery'],
          where: { marketplace: market, startDate: chosen.start, searchQuery: { in: blankTerms } },
        })
        : Promise.resolve([] as Array<{ searchQuery: string }>),
    ])
    for (const s of seen) if (s._max.startDate) lastSeen.set(norm(s.searchQuery), s._max.startDate)
    for (const a of anyAsin) coveredElsewhere.add(norm(a.searchQuery))
  }

  /**
   * KT.5 — do we advertise on this term, and does the feed cover the ASINs that do?
   *
   * The attribution hazard, measured: `giacca moto 4 stagioni` renders 1.67% attributed to
   * B0BMSJWW7L, which is in NONE of the 12 ad groups bidding that term — those hold 30 ASINs and SQP
   * covers 0 of them. 7 such rows across the four markets; 24 rows at 0% ad coverage.
   */
  const adGroupsByTerm = new Map<string, Set<string>>()
  const asinsByAdGroup = new Map<string, Set<string>>()
  {
    for (const t of adTargets) {
      const k = norm(t.expressionValue)
      const set = adGroupsByTerm.get(k) ?? new Set<string>()
      set.add(t.adGroupId); adGroupsByTerm.set(k, set)
    }
    const groupIds = [...new Set([...adGroupsByTerm.values()].flatMap((x) => [...x]))]
    if (groupIds.length) {
      const groupAds = await prisma.adProductAd.findMany({
        where: { adGroupId: { in: groupIds }, asin: { not: null } },
        select: { adGroupId: true, asin: true },
      })
      for (const a of groupAds) {
        const set = asinsByAdGroup.get(a.adGroupId) ?? new Set<string>()
        set.add(a.asin!); asinsByAdGroup.set(a.adGroupId, set)
      }
    }
  }

  /** newest period before the chosen one that holds each term, with that period's best-ASIN share */
  const prior = new Map<string, { period: Date; share: number; volume: number }>()
  for (const r of priorRows) {
    const k = norm(r.searchQuery)
    const share = Number(r.impressionShare)
    const volume = r.searchQueryVolume ?? 0
    const cur = prior.get(k)
    if (!cur || +r.startDate > +cur.period) prior.set(k, { period: r.startDate, share, volume })
    else if (+r.startDate === +cur.period && share > cur.share) prior.set(k, { period: cur.period, share, volume })
  }
  // ── KT.10 — what the MARKET did, like-for-like ────────────────────────────────────────────────
  //
  // 🔴 The health line described thinness as feed silence. Measured 2026-08-15, the dominant cause is
  // not silence: IT's search volume fell 46 % between 07-12 and 08-02 while our impressions fell only
  // 10 %, so our share ROSE 0.296 % → 0.490 %. An operator reading "the feed is thin" concludes the
  // opposite of what happened.
  //
  // 🔴 It compares against the period the Δ COLUMN predominantly uses — the modal `priorPeriod` across
  // measured terms — not the immediately preceding stored week. A first cut used the latter and
  // returned null in IT and DE, because the week before 08-02 is 07-26, which holds 8 IT rows: the
  // overlap fell below the five-pair floor. Worse than null, it would have made the line and the
  // column describe different comparisons on the same screen, which is the defect KT.7 paid for.
  //
  // LIKE-FOR-LIKE, and it has to be: this sums only (searchQuery, asin) pairs present in BOTH periods.
  // An aggregate over all rows folds coverage change into market change.
  const marketMovement = await (async () => {
    if (!chosen.start) return null
    const tally = new Map<number, number>()
    for (const p of prior.values()) tally.set(+p.period, (tally.get(+p.period) ?? 0) + 1)
    const modal = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!modal) return null
    const prevStart = new Date(modal[0])
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: market, reportPeriod: 'WEEK', startDate: { in: [chosen.start, prevStart] } },
      select: { startDate: true, searchQuery: true, asin: true, searchQueryVolume: true, impressionsTotal: true, impressionsBrand: true },
    })
    const k = (r: (typeof rows)[number]) => `${r.searchQuery}|${r.asin ?? ''}`
    const now = new Map(rows.filter((r) => +r.startDate === +chosen.start!).map((r) => [k(r), r]))
    const was = new Map(rows.filter((r) => +r.startDate === +prevStart).map((r) => [k(r), r]))
    const both = [...was.keys()].filter((x) => now.has(x))
    if (both.length < 5) return null   // fewer than five pairs is an anecdote, not a movement
    const sum = (m: typeof now, f: (r: (typeof rows)[number]) => number) =>
      both.reduce((t, x) => t + (f(m.get(x)!) || 0), 0)
    const volWas = sum(was, (r) => r.searchQueryVolume ?? 0), volNow = sum(now, (r) => r.searchQueryVolume ?? 0)
    const impWas = sum(was, (r) => r.impressionsTotal ?? 0), impNow = sum(now, (r) => r.impressionsTotal ?? 0)
    const ourWas = sum(was, (r) => r.impressionsBrand ?? 0), ourNow = sum(now, (r) => r.impressionsBrand ?? 0)
    return {
      priorPeriod: iso(prevStart), pairs: both.length,
      volumeDeltaPct: volWas > 0 ? ((volNow - volWas) / volWas) * 100 : null,
      ourImpressionsDeltaPct: ourWas > 0 ? ((ourNow - ourWas) / ourWas) * 100 : null,
      sharePriorPct: impWas > 0 ? (100 * ourWas) / impWas : null,
      shareNowPct: impNow > 0 ? (100 * ourNow) / impNow : null,
      /**
       * 🔴 Whether the newest period is SETTLED, because that decides how much weight this carries.
       * SQP.3 measured weeks frozen by ~25 days. Split by window: IT's 07-12 → 07-19 comparison (both
       * settled) shows volume −10 %, while 07-19 → 08-02 shows −40 % — so the headline decline sits
       * mostly in the newer, possibly-still-filling week. The page says that rather than asserting a
       * halved market as fact.
       */
      newestIsSettled: (Date.now() - +chosen.start) / 86_400_000 >= 25,
    }
  })()

  const spendByTerm = new Map(spendRows.map((r) => [norm(r.query), {
    cents: Math.round(Number(r._sum.costMicros ?? 0n) / 10_000),
    clicks: r._sum.clicks ?? 0,
    orders: r._sum.orders7d ?? 0,
  }]))

  const rows: KtRow[] = visibleTerms.map((term) => {
    const inPeriod = byTerm.get(term) ?? []
    const spend = spendByTerm.get(term) ?? null
    const branded = isBranded(term)
    const groups = adGroupsByTerm.get(term)
    const adAsins = groups ? new Set([...groups].flatMap((g) => [...(asinsByAdGroup.get(g) ?? [])])) : new Set<string>()

    if (!inPeriod.length) {
      const seen = lastSeen.get(term) ?? null
      const state: KtRowState = coveredElsewhere.has(term)
        ? 'not-measurable-here'
        : seen ? 'no-row-this-period' : 'never-measured'
      return {
        keyword: term, marketplace: market,
        marketVolume: null, marketRank: null, impressionShare: null,
        asinsCompeting: 0, asOf: null, asOfAgeDays: null,
        state,
        lastSeen: iso(seen), lastSeenAgeDays: ageDays(seen),
        bestAsin: null, shareBound: null,
        ad: groups ? { bidOnTerm: true, adAsins: adAsins.size, coveredAdAsins: 0, bestAsinAdvertisesTerm: false } : null,
        // A row with no share has no Δ BY CONSTRUCTION — never render one as a separate absence.
        deltaPP: null, marketDeltaPct: null, deltaGapDays: null, priorShare: null, priorPeriod: null,
        // Spend is not conditional on the share: we can pay for a term Brand Analytics never reports.
        spendCents: spend?.cents ?? null, clicks: spend?.clicks ?? null, orders: spend?.orders ?? null,
        measured: false, branded,
      }
    }
    // our BEST ASIN on this query — the one whose share we would be defending
    const best = inPeriod.reduce((a, b) => (b.impressionShare > a.impressionShare ? b : a))
    const p = prior.get(term) ?? null
    const covered = new Set(inPeriod.map((r) => r.asin).filter((x): x is string => !!x))
    // the SUM is an upper bound, not a total — two of our ASINs can share one impression
    const bound = inPeriod.reduce((acc, r) => acc + r.impressionShare, 0)
    return {
      keyword: term, marketplace: market,
      marketVolume: best.searchQueryVolume,
      marketRank: best.searchQueryRank,
      impressionShare: best.impressionShare,
      asinsCompeting: covered.size,
      asOf: iso(chosen.start),
      asOfAgeDays: ageDays(chosen.start),
      state: 'measured',
      lastSeen: null, lastSeenAgeDays: null,
      bestAsin: best.asin,
      shareBound: covered.size > 1 ? bound : null,
      ad: groups
        ? {
          bidOnTerm: true,
          adAsins: adAsins.size,
          coveredAdAsins: [...covered].filter((a) => adAsins.has(a)).length,
          bestAsinAdvertisesTerm: !!best.asin && adAsins.has(best.asin),
        }
        : null,
      deltaPP: p ? (best.impressionShare - p.share) * 100 : null,
      // Same term, same two periods as the Δ above. Null when the prior period recorded no volume,
      // rather than a fabricated 0 % or an Infinity from dividing by nothing.
      marketDeltaPct: p && p.volume > 0 && best.searchQueryVolume != null
        ? ((best.searchQueryVolume - p.volume) / p.volume) * 100
        : null,
      deltaGapDays: p ? Math.round((+chosen.start! - +p.period) / 86_400_000) : null,
      priorShare: p?.share ?? null,
      priorPeriod: iso(p?.period ?? null),
      spendCents: spend?.cents ?? null, clicks: spend?.clicks ?? null, orders: spend?.orders ?? null,
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
      // 🔴 KT.3 — the two sparse columns sort BLANKS LAST IN BOTH DIRECTIONS. 32 IT terms have no
      // spend and 19 no Δ; with a naive null-as-zero, "sort by spend ascending" would surface 32
      // unmeasured rows instead of the cheapest measured one, which is the question being asked.
      case 'delta': return nullsLast(a.deltaPP, b.deltaPP, s)
      case 'spend': return nullsLast(a.spendCents, b.spendCents, s)
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

  /**
   * 🔴 KT.3 — `topOfSearchIS` is a SCOPE fact, not a column. It is campaign-grain: measured
   * 2026-08-12, only 54 of IT's 149 campaigns carry a reading (DE 8 of 38, ES 1 of 10, FR 2 of 22),
   * so on a market grid every row would show one average of many campaigns, and under a campaign
   * scope the identical number on every row. A column whose value does not vary by row is not a
   * column — the same test that keeps `Organic Rank` off this page, applied from the other side.
   * So it goes where scope facts already live: the reach line.
   *
   * Its date is a LAG, not an age: the IS column stops exactly one day behind the placement report
   * it rides on (report 2026-08-11, IS 2026-08-10).
   */
  const scopeExternalIds = campaigns
    .filter((c) => c.marketplace === market && String(c.status) !== 'ARCHIVED'
      && (scope.boundBy === 'market' || scope.campaignIds.includes(c.id)))
    .map((c) => c.externalCampaignId)
    .filter((x): x is string => !!x)
  const tosRows = scopeExternalIds.length
    ? await prisma.amazonAdsPlacementReport.findMany({
      where: { campaignId: { in: scopeExternalIds }, topOfSearchIS: { not: null } },
      select: { campaignId: true, date: true, topOfSearchIS: true },
      orderBy: { date: 'desc' },
    })
    : []
  const latestTos = new Map<string, { share: number; date: Date }>()
  for (const r of tosRows) {
    if (!latestTos.has(r.campaignId)) latestTos.set(r.campaignId, { share: Number(r.topOfSearchIS), date: r.date })
  }
  const tos = latestTos.size
    ? {
      /** impression-unweighted mean of each campaign's most recent reading */
      avgShare: [...latestTos.values()].reduce((a, x) => a + x.share, 0) / latestTos.size,
      campaignsWithReading: latestTos.size,
      campaignsInScope: scopeExternalIds.length,
      asOf: iso([...latestTos.values()].reduce((a, x) => (+x.date > +a.date ? x : a)).date),
    }
    : null

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
  const notHereCount = rows.filter((r) => r.state === 'not-measurable-here').length

  /**
   * 🔴 KT.5 — THE COVERAGE DENOMINATOR. The reach line printed "250 ASINs", which is the ASINs in
   * SCOPE. Every share on this page is bounded by the ASINs Brand Analytics actually measures, and
   * that is a far smaller number: measured 2026-08-12, in the week each market's grid reads —
   * IT 18 of 250 · DE 13 of 57 · ES 14 of 30 · FR 4 of 91.
   *
   * Root cause is one constant: `ourAsinsForMarketplace(mkt, args.limit ?? 10)` at
   * sqp.service.ts:242 requests the same 10 ASINs per market every night and never rotates, despite
   * a code comment claiming the cron cycles coverage over days.
   */
  // Always filtered to the scope's ASINs — including at market scope, where `scope.asins` IS the set
  // of advertised ASINs. Without that the numerator counted every covered ASIN in the market (19)
  // against a denominator of advertised ones (250): it read as a coverage figure over a different
  // population, and N was not a subset of M.
  const coveredAsinsInWeek = chosen.start && scope.asins.length
    ? (await prisma.searchQueryPerformance.groupBy({
      by: ['asin'],
      where: { marketplace: market, startDate: chosen.start, asin: { in: scope.asins } },
    })).filter((r) => r.asin).length
    : 0

  /**
   * KT.5 — feed health, derived from DATA, never from `CronRun.status`.
   *
   * A run can be green and dead at once: measured, the 2026-08-11 and 2026-08-12 runs both carry
   * `status=SUCCESS` **and** `errorMessage="stale (auto-swept after 2.3h)"` **and** `rows=0`. Across
   * all 72 runs, 14 carry a stale error while only 12 have a non-SUCCESS status — so two are green
   * and dead. `ok=4 failed=5` has been constant since 2026-06-01 and can never signal anything: five
   * of the nine markets the cron iterates (IE, NL, PL, SE, UK) have zero ChannelListing rows, so
   * `ingestSqp` throws for them every night, forever. A sixth failure would be invisible.
   */
  const wroteByDay = new Map(ingestDays.map((r) => [r.day, Number(r.rows)]))
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0)
  let nightsSilent = 0
  for (let d = 0; d < 14; d++) {
    // an absent day is a ZERO, not a gap — counting zeros in the GROUP BY would always give 0
    const day = new Date(+midnight - d * 86_400_000).toISOString().slice(0, 10)
    if ((wroteByDay.get(day) ?? 0) === 0) nightsSilent++
    else break
  }
  // 🔴 SQP.1 — read the claim from EITHER field. `recordCronRun` persists `outputSummary` only on
  // the success path, and since SQP.1 a run that writes nothing in every market throws on purpose
  // so it can no longer leave a green row. Its summary therefore arrives inside `errorMessage`
  // instead — and parsing only `outputSummary` would have made the very runs this signal exists to
  // catch parse as "no claim", i.e. would have reported the fix as the absence of the defect.
  const claimedRows = recentRuns.map((r) => {
    const m2 = /rows=(\d+)/.exec(r.outputSummary ?? '') ?? /rows=(\d+)/.exec(r.errorMessage ?? '')
    return m2 ? Number(m2[1]) : null
  })
  let nightsClaimingZero = 0
  for (const n of claimedRows) { if (n === 0) nightsClaimingZero++; else break }
  const greenAndDead = recentRuns.filter((r) => String(r.status) === 'SUCCESS' && !!r.errorMessage).length
  // 🔴 The same candidate list and the same floor. KT.5's cliff dates answer "when does this view stop
  // being current"; computing them on the ratio while the grid runs on the floor would print a date
  // for a rule the page no longer uses.
  const cliff = projectCliff(periodCandidates, { floorAsins: KT_COVERAGE_FLOOR })

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
        /** the blank states, separated — see KtRowState */
        keywordsNoRowThisPeriod: noRowCount,
        keywordsNeverMeasured: neverCount,
        keywordsNotMeasurableHere: notHereCount,
        /**
         * 🔴 the honest denominator: of the `asins` in scope, how many the chosen week MEASURES.
         * The reach line must say "share measured across N of M advertised ASINs", never "M ASINs".
         */
        asinsCovered: coveredAsinsInWeek,
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
      /** KT.8 — distinct ASINs of ours measured in the chosen period, and the floor it had to meet.
       *  These are what the gate actually decided on; `baselineRows`/`threshold` stay because the
       *  health line still explains the feed's state in rows. */
      asins: chosen.asins,
      floorAsins: chosen.floorAsins,
      /** KT.10 — like-for-like market movement against the previous stored period; null when fewer
       *  than five (query, ASIN) pairs overlap, because that is an anecdote rather than a movement. */
      market: marketMovement,
      /** KT.10 — Amazon returns at most 100 queries per ASIN per week. Measured across 395 cells:
       *  none above 100, 70 at exactly 100. This is the real ceiling on terms covered, not the ASIN
       *  count — so a reach line that reads "12 of 250" invites exactly the wrong fix. */
      queriesPerAsinCap: SQP_QUERIES_PER_ASIN_CAP,
      /** KT.8 — the best coverage any period inside the lookback reached, so a refusal can say whether
       *  this week is thin or whether the market has never been measured well enough. */
      bestAsinsInWindow,
      /** KT.8 — 🔴 FR holds ZERO of these, which is why its coverage never reaches the floor. A
       *  refusal that says "incomplete data" sends an operator to the feed; this sends them to
       *  listing sync, which is where SQP.4 located the cause. */
      activeListings: activeListingCount,
      /** 🔴 deliberately NOT paired with a denominator here. The reach line's "N of M advertised" is
       *  SCOPE-level (`scope.resolved.asinsCovered` / `.asins`); this gate is MARKET-level. Printing
       *  one against the other would compare two different populations in a single sentence. */
      /** why this period: complete · incomplete-week · outside-lookback · no-data */
      reason: chosen.reason,
      truncated: chosen.truncated,
      /** newer periods the gate refused, newest first — so the page can name what it skipped */
      rejected: chosen.rejected,
      periodsUsed,
      newestAsOf: periodsUsed[0]?.start ?? null,
      oldestAsOf: periodsUsed[periodsUsed.length - 1]?.start ?? null,
    },
    /** KT.3 — a scope fact for the reach line, never a column. See the block that builds it. */
    topOfSearch: tos,
    /**
     * KT.5 — one health block, so the page can carry ONE line that is quiet when the feed is
     * behaving and loud when it is not. Derived from data; `CronRun.status` is never consulted.
     */
    feed: {
      /** consecutive most-recent nights that wrote no SQP row at all */
      nightsSilent,
      /** consecutive most-recent runs whose own summary says rows=0 */
      nightsClaimingZero,
      /** runs in the last 8 that report SUCCESS while carrying an errorMessage */
      greenAndDead,
      lastRunAt: recentRuns[0]?.startedAt.toISOString() ?? null,
      lastRunSummary: recentRuns[0]?.outputSummary ?? null,
      lastRunError: recentRuns[0]?.errorMessage ?? null,
      rowsWrittenPerNight: ingestDays.slice(0, 7).map((r) => ({ day: r.day, rows: Number(r.rows) })),
      /**
       * The five markets whose ads connections are active but which hold no Amazon listing at all.
       *
       * 🔴 Their CONSEQUENCE changed on 2026-08-12 (SQP.1). They used to be iterated and throw every
       * night, which is what made `ok=4 failed=5` a constant that a sixth, real failure could hide
       * inside. The job now selects markets by whether we hold ASINs there and NAMES these as
       * skipped, so `failed` finally means something. Kept on the payload because "five of nine ads
       * markets are empty" is still worth saying — but it is no longer a description of a defect.
       */
      structuralFailures: ['IE', 'NL', 'PL', 'SE', 'UK'],
      /** the dates this view stops being current — see projectCliff */
      cliff,
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
