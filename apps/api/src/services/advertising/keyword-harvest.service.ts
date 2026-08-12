/**
 * HV.1 — the Keyword Harvest page's one read.
 *
 * **One question: which search terms have earned their own keyword?** (The second half of the
 * page's question — *did the last batch work?* — is HV.5, and this read does not pretend to
 * answer it.)
 *
 * Read-only. It creates no keyword, no negative, and nothing at Amazon.
 *
 * ── 🔴 Why this reimplements `previewHarvest` instead of calling it ───────────────────────────
 *
 * `ads-harvest.service.ts` is called by the live cron (`ads-auto-harvest.service.ts:31/48`), by
 * `ads-recommendations.service.ts`, by `automation-action-handlers.ts`, and by two routes in
 * `advertising.routes.ts`. Changing it changes five write paths. So the query is rebuilt here with
 * four repairs that make the count TRUE, and the write path is left exactly where it was.
 *
 * The four repairs, each measured on prod 2026-08-12 (`scripts/_hv-1-candidates.mts`):
 *
 *   1. **The auto-targeting blind spot.** `advertising-rule-evaluator.job.ts:685` filters
 *      `matchType IN ('BROAD','PHRASE') OR matchType IS NULL`, explaining the null branch as
 *      "auto-targeting, no match type". **Not one row in this account has a NULL matchType** —
 *      zero of 10,826. Auto campaigns carry `TARGETING_EXPRESSION_PREDEFINED` (2,588 rows,
 *      19 orders) and product-targeting carries `TARGETING_EXPRESSION` (210 rows, 7 orders), so
 *      2,798 rows and 26 orders — the entire auto→manual funnel, which is the point of harvesting
 *      — are structurally invisible to the rule path. This read filters on no match type at all,
 *      and carries the match mix on every row so the funnel is legible rather than assumed.
 *
 *   2. **The existence join.** `previewHarvest` never checks whether the keyword already exists.
 *      Every candidate here resolves into exactly one of four states — see `HvStatus`. At the
 *      default threshold, **0 of 14 candidates are new**. That is the finding this page exists to
 *      state, not to hide.
 *
 *   3. **A marketplace filter.** `previewHarvest` groups `AmazonAdsSearchTerm` across every
 *      market — there is no marketplace predicate anywhere in it. The column is populated on all
 *      10,826 rows (IT 6,171 · DE 2,681 · ES 1,143 · FR 831), so scope reaches the query here.
 *
 *   4. **A scope filter.** line · portfolio · campaign · ad group, ANDed, resolved server-side,
 *      returning `boundBy` so the bar can say which grain actually bound the read.
 *
 * ── 🔴 The thing that makes "0 of 14" readable, and that the study missed ─────────────────────
 *
 * `previewHarvest` has no match-type filter, which repair 1 keeps deliberately — but it has a
 * consequence nobody had measured: **a term that matched an EXACT keyword is offered as a
 * candidate to create that same EXACT keyword.** Measured at the default threshold
 * (`scripts/_hv-1-matchtype.mts`):
 *
 *   every order from an EXACT match:   5 of 14   ← "already exact here" is the INPUT, not a finding
 *   at least one EXACT-matched order:  6 of 14
 *   no EXACT match at all:             8 of 14   ← PHRASE 5 · BROAD 2 · auto 1. Genuine candidates.
 *
 * So "0 of 14 are new" is about one third tautology and two thirds a real fact about the account.
 * The page must say which is which, and `matchedVia` on every row is how. At 1+ order the split
 * is 73 of 86 with no EXACT match — that is the real discovery set, and it is much larger than
 * the candidate count suggests.
 *
 * ── Laws inherited from NEG.1 and KT.1b ──────────────────────────────────────────────────────
 *
 *   · **A blank is not a zero.** `acosPct` and `cpcCents` are `null` when there is nothing to
 *     divide by. "not measured" and a real 0.00 must never render the same.
 *   · **`local-only` is a status, not an absence.** 210 of 2,129 positive keywords carry no
 *     Amazon id and **209 of those 210 were written by the harvest engine**. A row saying
 *     "already exact" when the keyword never reached Amazon is the same lie as an empty grid
 *     under a badge of 5.
 *   · **Never read `AdTarget.impressions/clicks/spendCents/salesCents/ordersCount`** — measured
 *     0 on all 5,213 rows. Nothing here touches them; performance lives in
 *     `AmazonAdsDailyPerformance` and belongs to HV.5.
 *   · **Negativity is `isNegative`, NEVER `expressionType`.** 1,068 negatives are stored with
 *     `expressionType = 'EXACT'`, and the column is being rewritten by an ingest (NEG.1's
 *     header). Every match-type comparison here is normalised at read time and no filter branches
 *     on the raw spelling.
 */

import prisma from '../../db.js'
// HV.2 — the stored criteria. Kept in its own module because HV.4 (the write path) and any later
// engine repair must resolve the SAME policy this page renders, and a copy would drift.
import { resolveHarvestPolicy, type HarvestCriteria, type HvPolicyGrain } from './harvest-policy.service.js'
// HV.3 — where a graduated keyword would go, and the §4.1 coupling that follows from it.
import {
  loadDestinationGraph, resolveStoredDestinations, resolveDestination,
  type ResolvedDestination, type HvCreateType,
} from './harvest-destination.service.js'

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const HV_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
/**
 * `all` is legitimate here, as it is on Negative Targeting and unlike on the Keyword Tracker.
 * Everything this page counts is a count of terms and a sum of euros, and both sum honestly
 * across markets. Every row carries its own market, so the merged view still reads.
 */
export const HV_MARKET_ALL = 'all'

const inScopeMarket = (m: string | null | undefined, market: string): boolean =>
  market === HV_MARKET_ALL ? HV_MARKETS.includes((m ?? '') as (typeof HV_MARKETS)[number]) : m === market

export type HvGrain = 'market' | 'line' | 'portfolio' | 'campaign' | 'adGroup'
export type HvKind = 'keyword' | 'product'

/**
 * The four states every candidate resolves into. There is no fifth, and there is no blank.
 *
 *   `new`                 no positive keyword for this text anywhere
 *   `already-exact-here`  an EXACT AdTarget exists in the SOURCE ad group and reached Amazon
 *   `exact-elsewhere`     exists as EXACT in a different ad group
 *   `local-only`          a row exists in the source ad group but NONE of them reached Amazon
 *
 * `local-only` is checked BEFORE `already-exact-here` resolves, because the two are the same row
 * set distinguished only by `externalTargetId`. Getting that order wrong is how a page tells you a
 * keyword is in place when Amazon has never heard of it.
 */
export type HvStatus = 'new' | 'already-exact-here' | 'exact-elsewhere' | 'local-only'

/** H.5's rule, unchanged: a query that is an ASIN is a product-targeting match, not a keyword. */
const isAsinQuery = (q: string): boolean => /^b0[a-z0-9]{8}$/i.test(q.trim())

/** One normalisation for a term, used for every join key on this page. */
const termKeyOf = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Six spellings of three concepts, collapsed — NEG.1's `normaliseMatchType`, narrowed to the one
 * question this page asks of a positive target: is it EXACT? The ingest rewrites this column
 * (`ads-keyword-list-sync.service.ts:157` turns `NEGATIVE_EXACT` into `_EXACT`), so a comparison
 * against one spelling returns a different row set every few minutes.
 */
const isExactType = (expressionType: string | null | undefined): boolean =>
  String(expressionType ?? '').trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '') === 'EXACT'

// ── Scope ─────────────────────────────────────────────────────────────────────────────────────

export interface HvScopeGraph {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  /** one row per AdProductAd carrying a productId, joined up to its campaign */
  ads: Array<{ productId: string | null; campaignId: string }>
  /** every advertised product with its parent — a line is a parent id; a parentless product is its own line */
  products: Array<{ id: string; parentId: string | null }>
  /** ad groups that hold at least one search term in the window, so the fifth picker cannot offer an empty one */
  adGroups: Array<{ id: string; name: string; campaignId: string }>
}

export interface HvScopeRequest {
  market: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
  adGroup?: string | null
}

export interface HvResolvedScope {
  boundBy: HvGrain
  campaignIds: string[]
  /** set only when the ad-group grain bound; otherwise null = every ad group in `campaignIds` */
  adGroupIds: string[] | null
  campaignsInMarket: number
}

/**
 * market → line → portfolio → campaign → ad group, cascading, most specific wins.
 *
 * Ad group is a fifth grain specific to this page, and it is the grain a harvest candidate
 * actually HAS: `AmazonAdsSearchTerm.adGroupId` holds an `externalAdGroupId`, and a term's whole
 * identity on this page is (term × campaign × ad group).
 *
 * A campaign id from another market resolves to NOTHING rather than quietly overriding the market
 * picker — two controls the operator set separately cannot both be honoured, and silently
 * preferring one is how a shared link shows a different thing to the person who opens it.
 *
 * ⚠ This is a READ filter. Rule scope is single-valued (`scopeCampaignId`, AUTO §11 C4) and that
 * constraint is about rules; it does not apply here and the two must not be confused.
 */
export function resolveHvScope(graph: HvScopeGraph, req: HvScopeRequest): HvResolvedScope {
  const inMarket = graph.campaigns.filter((c) => inScopeMarket(c.marketplace, req.market))
  const base = { campaignsInMarket: inMarket.length }
  const marketIds = new Set(inMarket.map((c) => c.id))

  if (req.adGroup) {
    const ag = graph.adGroups.find((g) => g.id === req.adGroup && marketIds.has(g.campaignId))
    return ag
      ? { ...base, boundBy: 'adGroup', campaignIds: [ag.campaignId], adGroupIds: [ag.id] }
      : { ...base, boundBy: 'adGroup', campaignIds: [], adGroupIds: [] }
  }

  if (req.campaign) {
    const c = inMarket.find((x) => x.id === req.campaign)
    return { ...base, boundBy: 'campaign', campaignIds: c ? [c.id] : [], adGroupIds: null }
  }

  // portfolio — `Campaign.portfolioId` is Amazon's EXTERNAL portfolio id, not a local row id.
  if (req.portfolio) {
    return { ...base, boundBy: 'portfolio', campaignIds: inMarket.filter((c) => c.portfolioId === req.portfolio).map((c) => c.id), adGroupIds: null }
  }

  // line — a Product parent id; the campaigns advertising any of its children.
  if (req.line) {
    const lineOf = new Map(graph.products.map((p) => [p.id, p.parentId ?? p.id]))
    const ids = new Set<string>()
    for (const a of graph.ads) {
      if (!a.productId || !marketIds.has(a.campaignId)) continue
      if (lineOf.get(a.productId) === req.line) ids.add(a.campaignId)
    }
    return { ...base, boundBy: 'line', campaignIds: [...ids].sort(), adGroupIds: null }
  }

  return { ...base, boundBy: 'market', campaignIds: [...marketIds].sort(), adGroupIds: null }
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────

export interface HarvestRow {
  /** stable across reloads and sortable — market × campaign × ad group × term */
  id: string
  term: string
  termKey: string
  market: string
  kind: HvKind
  campaign: { id: string | null; name: string; externalId: string; targetingType: string | null; status: string | null }
  adGroup: { id: string | null; name: string; externalId: string }
  metrics: {
    impressions: number
    clicks: number
    spendCents: number
    orders: number
    salesCents: number
    /** null when there are no sales to divide by — a blank is not a zero */
    acosPct: number | null
    /** the bid this term has EARNED: cost ÷ clicks. null when it has never been clicked. */
    cpcCents: number | null
  }
  /**
   * 🔴 Which match types actually produced this term's orders.
   *
   * `previewHarvest` has no match-type filter, so a term that matched an EXACT keyword is offered
   * as a candidate to create that same keyword. Without this the reader cannot tell a tautology
   * (5 of 14) from a genuine PHRASE/BROAD/auto discovery (8 of 14).
   */
  matchedVia: Array<{ matchType: string; orders: number }>
  /** true when every attributed order came from an EXACT match — i.e. the keyword IS the traffic */
  exactMatchedOnly: boolean
  status: HvStatus
  /** what the existence join found. null only when `status === 'new'`. */
  existing: { rows: number; atAmazon: number; bidCents: number | null; adGroups: string[] } | null
  /**
   * D5 — the read-only flag. Account-wide, and labelled as such on the view: a term negated in a
   * campaign you are not looking at still blocks it there. Refusing to PROPOSE a negated term is
   * HV.4; this only states the fact.
   */
  negatedIn: { rows: number; blocking: number; campaignLevel: number }
  /**
   * HV.3 — where this candidate would go, how that was decided, and whether the source would be
   * negated. `null` only when the row has no local ad group at all.
   *
   * 🔴 The destination is what decides the isolation negative: `applyHarvest` negates the source
   * ONLY when the keyword lands elsewhere. So "promoted into the source" and "did not negate the
   * source" are one fact, and it is computed here rather than inferred by the client.
   */
  destination: ResolvedDestination | null
}

export interface HvCensus {
  /** candidates at the current threshold, in the current scope */
  candidates: number
  /**
   * 🔴 The split the study's headline sentence did not have, and needs.
   *
   * `previewHarvest` returns `graduations` and `productGraduations` as two lists; this page shows
   * them as one grid with a Kind column, so `candidates` is their SUM. At the default threshold
   * that is 17 = 14 keyword + 3 product — and the single `new` candidate is a PRODUCT target, so
   * "0 of 14 are new" is true of the keywords and false of the whole grid. A census that stated
   * only one of those numbers would be wrong whichever one it picked.
   */
  byKind: { keyword: number; product: number }
  newByKind: { keyword: number; product: number }
  new: number
  alreadyExactHere: number
  exactElsewhere: number
  localOnly: number
  /** of `candidates`, how many are already negated somewhere */
  negatedAlready: number
  /** of `candidates`, how many got EVERY order from an EXACT match — the tautological ones */
  exactMatchedOnly: number
  /**
   * The one-order view, which is the argument for the page. Computed over the same scope with
   * `minOrders = 1`, because the whole finding of the study is that the threshold decides whether
   * this tab has any content.
   */
  atOneOrder: {
    candidates: number
    /** no EXACT keyword in the SOURCE ad group — new + exact-elsewhere + local-only */
    withoutKeywordInSource: number
    /**
     * Of `withoutKeywordInSource`, how many never matched an EXACT keyword at all — the real
     * discovery set. Same denominator as the number beside it, deliberately: a guard must share
     * the denominator of the value it guards (AUTO §11 C5, and the bug this section has already
     * shipped twice).
     */
    noExactMatch: number
    spendCents: number
    salesCents: number
    acosPct: number | null
    /**
     * ⚠️ The attribution caveat, as a number rather than a sentence. These are single-order
     * attributions and the sale values REPEAT — one product at one price converting once per
     * term. `repeatedValues` lists the sale amounts claimed by more than one term. Evidence of
     * intent, not a bankable total, and the view says so.
     */
    singleOrder: number
    repeatedValues: Array<{ salesCents: number; terms: number }>
  }
  /**
   * D4 — the wasteful-term negatives belong to Negative Targeting, which already has
   * `NegWastefulWords.tsx` stubbed for them. Stated here with a link out; never rendered in this
   * grid.
   */
  negativeCandidates: { count: number; spendCents: number }
  /** HV.3 — how the destination resolved across the whole candidate set, and the §4.1 coupling. */
  destinations: {
    stored: number
    resolvedUnique: number
    ambiguous: number
    none: number
    wouldNegate: number
    wouldNotNegate: number
    wouldDuplicate: number
  }
  /** ASIN candidates, split the way `applyHarvest` splits them */
  productCandidates: { graduations: number; negatives: number }
}

export interface HvPayload {
  scope: {
    market: string
    boundBy: HvGrain
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    adGroup: { id: string; name: string } | null
    resolved: { campaigns: number; campaignsInMarket: number; campaignsWithTerms: number; adGroups: number }
    /** the fifth picker's options — only the ad groups that actually hold a term in this window */
    adGroupOptions: Array<{ id: string; name: string; campaignName: string; terms: number }>
  }
  window: { days: number; since: string; until: string }
  thresholds: { minOrders: number; minSpendEur: number }
  /**
   * HV.2 — the criteria in force for this view, and where each half came from.
   *
   * `inForce` is what the grid actually applied. `policy` is what would apply with no URL
   * overrides at all, plus which grain supplied it. `overridden` names the criteria the URL is
   * currently changing, so the page can mark them and offer to save them.
   */
  criteria: {
    inForce: HarvestCriteria
    policy: {
      criteria: HarvestCriteria
      source: HvPolicyGrain | 'default'
      sourceScopeId: string | null
      /** a row exists at the most specific grain the operator picked → offer "update", not "create" */
      hasOwn: boolean
      /** the grain a Save would write to, given what is picked right now */
      saveGrain: HvPolicyGrain
      saveScopeId: string | null
      updatedAt: string | null
      updatedBy: string | null
    }
    overridden: string[]
  }
  /**
   * Per-criterion attrition. **A single surviving count tells you nothing about which knob to
   * turn** — this is what makes the controls legible rather than decorative.
   */
  attrition: {
    base: number
    baseLabel: string
    /** `removedNew` is how many of that step's removals were `new` — see the note in applyCriteria */
    steps: Array<{ key: string; label: string; removed: number; remaining: number; removedNew: number }>
  }
  /**
   * 🔴 Computed, never stated as a constant. The study said "1 day old"; one day later it was two,
   * because `ads-v1-export-ingest` has returned `ingested=0 rows=0` on every run since
   * 2026-08-11T01:52. A page that hard-codes the age is wrong within 24 hours.
   */
  freshness: { newestTermDate: string | null; ageDays: number | null; newestRowWrittenAt: string | null; rows: number }
  census: HvCensus
  facets: {
    status: Array<{ value: HvStatus; count: number }>
    kind: Array<{ value: HvKind; count: number }>
    market: Array<{ value: string; count: number }>
    targetingType: Array<{ value: string; count: number }>
    matchedVia: Array<{ value: string; count: number }>
  }
  rows: HarvestRow[]
  total: number
  truncated: boolean
}

export interface HvRequest extends HvScopeRequest {
  /**
   * 🔴 HV.2 — the FILTER, not the policy.
   *
   * Each of these is an override of the criterion the resolved policy supplies. Absent means "use
   * the policy", never "use a hard-coded default" — the defaults live in
   * `harvest-policy.service.ts` and are reached only when no policy row exists at any grain.
   *
   * The two are deliberately separate all the way down: a URL override changes this view and binds
   * nothing, a policy changes the default for everyone in that scope. Composing them here rather
   * than in the client means the server always knows which is which, and can say so.
   */
  windowDays?: number | null
  minOrders?: number | null
  minClicks?: number | null
  /** `'none'` explicitly clears the ceiling for this view; absent leaves the policy's in place. */
  maxAcosPct?: number | 'none' | null
  /** 'harvestable' excludes candidates whose every order arrived via an EXACT match; 'all' keeps them. */
  matched?: 'all' | 'harvestable' | null
  minSpendEur?: number | null
  status?: HvStatus | 'all' | null
  kind?: HvKind | 'all' | null
  /** HV.3 — filter by how the destination resolved */
  dest?: 'all' | 'proposed' | 'overridden' | 'none' | null
  /** HV.3 — only rows that would create a second exact keyword for a term already held elsewhere */
  competing?: boolean | null
  q?: string | null
  sort?: HvSortKey | null
  dir?: 'asc' | 'desc'
}

export type HvSortKey = 'term' | 'market' | 'source' | 'impressions' | 'clicks' | 'spend' | 'orders' | 'sales' | 'acos' | 'cpc' | 'status' | 'negated' | 'kind'

const MAX_ROWS = 2000
// 🔴 The graduation defaults moved to `harvest-policy.service.ts` (HV_DEFAULT_CRITERIA) so there is
// ONE place a threshold is decided. Only the negation threshold stays here, and only because it is
// used solely for the D4 census figure this page links out with — Negative Targeting owns the
// control, and this page renders none.
const DEFAULT_MIN_SPEND_EUR = 15

const tally = <T, K extends string>(xs: T[], f: (x: T) => K | null): Array<{ value: K; count: number }> => {
  const m = new Map<K, number>()
  for (const x of xs) { const k = f(x); if (k != null) m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
}

export async function getKeywordHarvest(req: HvRequest): Promise<HvPayload> {
  // 30 / 60 / 90 only. An arbitrary window would make two links incomparable, and the account
  // produces 14 double-order terms in SIXTY days — a 7-day harvest window here is a random-number
  // generator (page study §5.3).
  // 🔴 The policy first, then the URL on top of it. Order matters: the policy is the DEFAULT this
  // view starts from, and every URL param is an explicit, temporary override of one of its fields.
  // Resolving in the other direction would make a saved policy invisible whenever a link happened
  // to carry a param.
  const policy = await resolveHarvestPolicy({
    market: req.market, line: req.line, portfolio: req.portfolio, campaign: req.campaign, adGroup: req.adGroup,
  })
  const pc = policy.criteria

  const windowDays = [30, 60, 90].includes(Number(req.windowDays)) ? Number(req.windowDays) : pc.windowDays
  const minOrders = req.minOrders != null && Number(req.minOrders) >= 1 ? Math.floor(Number(req.minOrders)) : pc.minOrders
  const minClicks = req.minClicks != null && Number(req.minClicks) >= 0 ? Math.floor(Number(req.minClicks)) : pc.minClicks
  // 'none' is how a view says "no ceiling" out loud. Without it, clearing the ceiling and never
  // having had one would be the same URL, and a link could not carry the difference.
  const maxAcosPct = req.maxAcosPct === 'none' ? null
    : (req.maxAcosPct != null && Number(req.maxAcosPct) > 0 ? Math.floor(Number(req.maxAcosPct)) : pc.maxAcosPct)
  const excludeExactMatched = req.matched === 'all' ? false : req.matched === 'harvestable' ? true : pc.excludeExactMatched
  const minSpendEur = req.minSpendEur != null && Number(req.minSpendEur) >= 0 ? Number(req.minSpendEur) : DEFAULT_MIN_SPEND_EUR

  /** Which criteria this VIEW is overriding, so the page can mark them and offer to save them. */
  const overridden: string[] = []
  if (windowDays !== pc.windowDays) overridden.push('windowDays')
  if (minOrders !== pc.minOrders) overridden.push('minOrders')
  if (minClicks !== pc.minClicks) overridden.push('minClicks')
  if (maxAcosPct !== pc.maxAcosPct) overridden.push('maxAcosPct')
  if (excludeExactMatched !== pc.excludeExactMatched) overridden.push('excludeExactMatched')
  const minSpendCents = Math.round(minSpendEur * 100)
  const until = new Date()
  const since = new Date(until.getTime() - windowDays * 86_400_000)

  // ── the scope graph. The product graph is read ONLY when the line grain is in play: it is the
  // most expensive part of this call and it decides nothing at the other four grains (NEG.1
  // measured ~1.2s of a ~2s page load for a scope that never used it).
  const wantsLine = !!req.line && !req.campaign && !req.adGroup && !req.portfolio

  // The fifth picker's universe: ad groups that hold a term in the window. Two steps, because
  // AmazonAdsSearchTerm carries EXTERNAL ids and AdGroup is keyed locally.
  const termAdGroups = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['adGroupId'],
    where: { date: { gte: since }, ...(req.market === HV_MARKET_ALL ? {} : { marketplace: req.market }) },
    _count: true,
  })
  const termsByExtAdGroup = new Map(termAdGroups.map((g) => [g.adGroupId, g._count]))

  const [campaigns, portfolios, ads, products, adGroupRows] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, targetingType: true, externalCampaignId: true }, orderBy: { name: 'asc' } }),
    prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true } }),
    wantsLine ? prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
    req.line ? prisma.product.findMany({ select: { id: true, sku: true, name: true, parentId: true } }) : Promise.resolve([]),
    prisma.adGroup.findMany({ where: { externalAdGroupId: { in: [...termsByExtAdGroup.keys()] } }, select: { id: true, name: true, campaignId: true, externalAdGroupId: true }, orderBy: { name: 'asc' } }),
  ])

  const campById = new Map(campaigns.map((c) => [c.id, c]))
  const campByExt = new Map(campaigns.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId!, c]))
  const agByExt = new Map(adGroupRows.filter((a) => a.externalAdGroupId).map((a) => [a.externalAdGroupId!, a]))
  const agById = new Map(adGroupRows.map((a) => [a.id, a]))

  const graph: HvScopeGraph = {
    campaigns,
    ads: ads.map((a) => ({ productId: a.productId, campaignId: a.adGroup?.campaignId ?? '' })).filter((a) => a.campaignId),
    products,
    adGroups: adGroupRows.map((a) => ({ id: a.id, name: a.name, campaignId: a.campaignId })),
  }
  const scope = resolveHvScope(graph, req)

  // ── the scope, translated into the EXTERNAL ids the search-term table actually holds. This is
  // repair 4: the filter reaches the query rather than the grid.
  const scopedCampaignExtIds = scope.campaignIds
    .map((id) => campById.get(id)?.externalCampaignId)
    .filter((x): x is string => !!x)
  const scopedAdGroupExtIds = scope.adGroupIds
    ? scope.adGroupIds.map((id) => agById.get(id)?.externalAdGroupId).filter((x): x is string => !!x)
    : null

  // A resolved scope that maps to no external id must return NOTHING, not the whole account.
  // `{ in: [] }` matches nothing in Prisma, which is the behaviour we want — spelled out because
  // an empty array reads like "unset" and the fallback would be silently account-wide.
  const scopeMatchesNothing = scopedCampaignExtIds.length === 0

  // ── the candidate read. Repairs 1 and 3 are what is ABSENT here: no match-type predicate at
  // all, and a marketplace predicate that previewHarvest has never had.
  const grouped = scopeMatchesNothing ? [] : await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'campaignId', 'adGroupId', 'marketplace', 'matchType'],
    where: {
      date: { gte: since },
      ...(req.market === HV_MARKET_ALL ? {} : { marketplace: req.market }),
      campaignId: { in: scopedCampaignExtIds },
      ...(scopedAdGroupExtIds ? { adGroupId: { in: scopedAdGroupExtIds } } : {}),
    },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })

  /**
   * Re-aggregate to `previewHarvest`'s grain (term × campaign × ad group × market), carrying the
   * match mix. The extra `matchType` in the `by` above exists ONLY to produce `matchedVia` — the
   * thresholds are applied to the re-aggregated totals, exactly as `previewHarvest` applies them,
   * so this read cannot disagree with the engine about who is a candidate.
   */
  interface Agg {
    query: string; campaignId: string; adGroupId: string; marketplace: string
    impressions: number; clicks: number; costCents: number; orders: number; salesCents: number
    byMatch: Map<string, number>
  }
  const aggs = new Map<string, Agg>()
  for (const r of grouped) {
    const k = `${r.marketplace}|${r.campaignId}|${r.adGroupId}|${termKeyOf(r.query)}`
    const a = aggs.get(k) ?? {
      query: r.query, campaignId: r.campaignId, adGroupId: r.adGroupId, marketplace: r.marketplace,
      impressions: 0, clicks: 0, costCents: 0, orders: 0, salesCents: 0, byMatch: new Map<string, number>(),
    }
    const orders = r._sum.orders7d ?? 0
    a.impressions += r._sum.impressions ?? 0
    a.clicks += r._sum.clicks ?? 0
    a.costCents += Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
    a.orders += orders
    a.salesCents += r._sum.sales7dCents ?? 0
    if (orders > 0) a.byMatch.set(String(r.matchType ?? 'unattributed'), (a.byMatch.get(String(r.matchType ?? 'unattributed')) ?? 0) + orders)
    aggs.set(k, a)
  }
  const all = [...aggs.values()]

  // ── HV.3 — the destination graph and any stored overrides, read once for the whole request.
  // `loadDestinationGraph` is three reads; `resolveStoredDestinations` is one. Both are needed for
  // every row, so hoisting them out of the row loop is the difference between 4 queries and 4×N.
  const [destGraph, storedDest] = await Promise.all([
    loadDestinationGraph(),
    resolveStoredDestinations({ market: req.market, line: req.line, portfolio: req.portfolio, campaign: req.campaign, adGroup: req.adGroup }),
  ])

  // ── repair 2: the existence join. Read account-wide, because `exact-elsewhere` is by definition
  // a question about ad groups outside the scope.
  const positives = await prisma.adTarget.findMany({
    where: { isNegative: false, kind: { in: ['KEYWORD', 'PRODUCT'] } },
    select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, externalTargetId: true, bidCents: true },
  })
  const exactHere = new Map<string, typeof positives>()
  const exactAnywhere = new Map<string, typeof positives>()
  for (const p of positives) {
    // A PRODUCT target has no meaningful match type; an ASIN target IS its own exact match.
    const counts = p.kind === 'PRODUCT' ? true : isExactType(p.expressionType)
    if (!counts) continue
    const t = `${p.kind}|${termKeyOf(p.expressionValue)}`
    exactHere.set(`${p.adGroupId}|${t}`, [...(exactHere.get(`${p.adGroupId}|${t}`) ?? []), p])
    exactAnywhere.set(t, [...(exactAnywhere.get(t) ?? []), p])
  }

  // ── D5: the negation flag. 🔴 `isNegative`, NEVER `expressionType` — 1,068 negatives are stored
  // with a positive-sounding match type, so a filter branching on `expressionType` to decide
  // negativity is wrong for ~99% of rows.
  const negatives = await prisma.adTarget.findMany({
    where: { isNegative: true },
    select: { kind: true, expressionValue: true, adGroupId: true, negativeLevel: true, status: true, externalTargetId: true },
  })
  const negByTerm = new Map<string, { rows: number; blocking: number; campaignLevel: number }>()
  for (const n of negatives) {
    const ag = agById.get(n.adGroupId)
    const campStatus = ag ? campById.get(ag.campaignId)?.status : undefined
    const k = `${n.kind === 'PRODUCT' ? 'PRODUCT' : 'KEYWORD'}|${termKeyOf(n.expressionValue)}`
    const cur = negByTerm.get(k) ?? { rows: 0, blocking: 0, campaignLevel: 0 }
    cur.rows++
    // The same three-condition intersection NEG.1 uses. `campStatus` is undefined for ad groups
    // outside this window's set, so "blocking" is a floor, not a ceiling — and the row shows
    // `rows` beside it rather than only the intersection.
    if (n.status === 'ENABLED' && n.externalTargetId != null && campStatus === 'ENABLED') cur.blocking++
    if (n.negativeLevel === 'CAMPAIGN') cur.campaignLevel++
    negByTerm.set(k, cur)
  }

  /** The four states, in the one order that cannot lie. */
  function resolveStatus(a: Agg, kind: HvKind): { status: HvStatus; existing: HarvestRow['existing'] } {
    const key = `${kind === 'product' ? 'PRODUCT' : 'KEYWORD'}|${termKeyOf(a.query)}`
    const localAg = agByExt.get(a.adGroupId)
    const here = localAg ? exactHere.get(`${localAg.id}|${key}`) : undefined
    if (here?.length) {
      const reached = here.filter((h) => h.externalTargetId != null)
      const existing = {
        rows: here.length,
        atAmazon: reached.length,
        bidCents: (reached[0] ?? here[0]).bidCents ?? null,
        adGroups: [localAg!.name],
      }
      // 🔴 order matters: a row set where NOTHING reached Amazon is `local-only`, not "already
      // exact". 209 of the account's 210 local-only keywords were written by the harvest engine
      // reporting success.
      return reached.length ? { status: 'already-exact-here', existing } : { status: 'local-only', existing }
    }
    const anywhere = exactAnywhere.get(key)
    if (anywhere?.length) {
      const names = [...new Set(anywhere.map((p) => agById.get(p.adGroupId)?.name).filter((x): x is string => !!x))]
      return {
        status: 'exact-elsewhere',
        existing: { rows: anywhere.length, atAmazon: anywhere.filter((p) => p.externalTargetId != null).length, bidCents: anywhere[0].bidCents ?? null, adGroups: names },
      }
    }
    return { status: 'new', existing: null }
  }

  function toRow(a: Agg): HarvestRow {
    const kind: HvKind = isAsinQuery(a.query) ? 'product' : 'keyword'
    const { status, existing } = resolveStatus(a, kind)
    const camp = campByExt.get(a.campaignId)
    const ag = agByExt.get(a.adGroupId)
    const neg = negByTerm.get(`${kind === 'product' ? 'PRODUCT' : 'KEYWORD'}|${termKeyOf(a.query)}`) ?? { rows: 0, blocking: 0, campaignLevel: 0 }
    const matchedVia = [...a.byMatch.entries()].map(([matchType, orders]) => ({ matchType, orders })).sort((x, y) => y.orders - x.orders)
    const exactOrders = a.byMatch.get('EXACT') ?? 0
    return {
      id: `${a.marketplace}|${a.campaignId}|${a.adGroupId}|${termKeyOf(a.query)}`,
      term: a.query,
      termKey: termKeyOf(a.query),
      market: a.marketplace,
      kind,
      campaign: {
        id: camp?.id ?? null,
        // A campaign the search-term table names but our graph does not hold is a real state, and
        // it must not render as a blank cell that reads like a loading failure.
        name: camp?.name ?? `(not in Nexus — ${a.campaignId})`,
        externalId: a.campaignId,
        targetingType: camp?.targetingType ?? null,
        status: camp?.status ?? null,
      },
      adGroup: { id: ag?.id ?? null, name: ag?.name ?? `(not in Nexus — ${a.adGroupId})`, externalId: a.adGroupId },
      metrics: {
        impressions: a.impressions,
        clicks: a.clicks,
        spendCents: a.costCents,
        orders: a.orders,
        salesCents: a.salesCents,
        acosPct: a.salesCents > 0 ? (a.costCents / a.salesCents) * 100 : null,
        cpcCents: a.clicks > 0 ? a.costCents / a.clicks : null,
      },
      matchedVia,
      exactMatchedOnly: a.orders > 0 && exactOrders === a.orders,
      status,
      existing,
      negatedIn: neg,
      // 🔴 HV.3. The create type is the tightest one the term has EARNED — the same ladder the
      // looser-match criterion encodes: a keyword graduates to EXACT, an ASIN to a PRODUCT target.
      destination: ag
        ? resolveDestination({
          graph: destGraph, stored: storedDest,
          sourceAdGroupId: ag.id, sourceAdGroupName: ag.name,
          term: a.query, kind, createType: (kind === 'product' ? 'PRODUCT' : 'EXACT') as HvCreateType,
        })
        : null,
    }
  }

  // ── the candidate sets. Graduations are rows; wasteful negatives are counted and linked out
  // (D4) and never rendered here.
  /**
   * 🔴 The match-type criterion, stated once so the grid, the census and the attrition cannot
   * drift apart.
   *
   * A term is harvestable only where it arrived through a LOOSER match than the one we would
   * create: auto and product-expression → PHRASE/EXACT, BROAD → PHRASE/EXACT, PHRASE → EXACT.
   * A term whose EVERY order arrived via EXACT is not harvestable as a keyword — the traffic came
   * through the very keyword the row is offering to create.
   *
   * Aggregation reading, measured both ways before choosing (`_hv-2-criteria.mts`):
   *   A "every order came via EXACT"  excludes 5 of 17 at 2+ orders, 12 of 92 at 1+   ← CHOSEN
   *   B "any order came via EXACT"    excludes 6 / 13
   *   C "no LOOSER match at all"      excludes 5 / 12
   * A and C agree exactly. B is stricter by one row — `motorrad jacke`, EXACT=7 and BROAD=2 —
   * and those two BROAD orders are precisely the looser-match evidence harvesting looks for.
   * Discarding the term because it ALSO has a converting exact keyword throws away the signal.
   * A is also what `exactMatchedOnly` already reports on every row, so the page stays coherent.
   *
   * ⚠ Product candidates are exempt. An ASIN's match type is TARGETING_EXPRESSION*, never a
   * keyword match type, and the account's ONE genuinely-new candidate is a product target — a
   * keyword rule must not silently exclude it.
   */
  const isHarvestableByMatch = (a: Agg): boolean => {
    if (isAsinQuery(a.query)) return true
    return !(a.orders > 0 && (a.byMatch.get('EXACT') ?? 0) === a.orders)
  }
  const acosOf = (a: Agg): number | null => (a.salesCents > 0 ? (a.costCents / a.salesCents) * 100 : null)

  /**
   * The criteria, applied in the order the operator reads them. Returns the survivors and the
   * per-step attrition, because **a single surviving count tells you nothing about which knob to
   * turn** — "17 → 12" is useless where "orders removes 0 · clicks removes 1 · ACoS removes 0 ·
   * exact-matched removes 5" is a decision.
   */
  const applyCriteria = (list: Agg[], c: { minOrders: number; minClicks: number; maxAcosPct: number | null; excludeExactMatched: boolean }) => {
    const steps: Array<{ key: string; label: string; removed: number; remaining: number; removedNew: number }> = []
    let pool = list
    const step = (key: string, label: string, keep: (a: Agg) => boolean) => {
      const before = pool.length
      const dropped = pool.filter((a) => !keep(a))
      pool = pool.filter(keep)
      // 🔴 How many of the rows this step removed were `new` — the only status that represents a
      // keyword that does not exist yet, which is the entire point of the page.
      //
      // This is not decoration. Measured on prod 2026-08-12: the account holds exactly ONE
      // genuinely-new candidate at 2+ orders, and the shipped `minClicks: 3` removes it (2 orders
      // on 1 click). A criteria bar that silently took the page's only real finding off the screen
      // would be the most expensive kind of honest-looking control. The operator gets told, on the
      // step that did it, and can relax that one criterion to see it.
      const removedNew = dropped.filter((a) => resolveStatus(a, isAsinQuery(a.query) ? 'product' : 'keyword').status === 'new').length
      steps.push({ key, label, removed: before - pool.length, remaining: pool.length, removedNew })
    }
    step('minOrders', `${c.minOrders}+ order${c.minOrders === 1 ? '' : 's'}`, (a) => a.orders >= c.minOrders)
    step('minClicks', c.minClicks > 0 ? `${c.minClicks}+ clicks` : 'any clicks', (a) => a.clicks >= c.minClicks)
    step(
      'maxAcosPct',
      c.maxAcosPct == null ? 'no ACoS ceiling' : `ACoS ≤ ${c.maxAcosPct}%`,
      // 🔴 A candidate with orders but NO attributed sales has no ACoS. It is KEPT. Excluding on a
      // missing measurement is the blank-is-not-a-zero failure in filter form.
      (a) => { if (c.maxAcosPct == null) return true; const v = acosOf(a); return v == null ? true : v <= c.maxAcosPct },
    )
    step('excludeExactMatched', c.excludeExactMatched ? 'arrived via a looser match' : 'any match type', (a) => (c.excludeExactMatched ? isHarvestableByMatch(a) : true))
    return { pool, steps }
  }

  // The universe every criterion narrows: terms that converted at all inside this scope. Stated as
  // the attrition's base so the first step's removal is legible instead of dwarfing the rest.
  const converted = all.filter((a) => a.orders >= 1)
  const current = { minOrders, minClicks, maxAcosPct, excludeExactMatched }
  const applied = applyCriteria(converted, current)
  const graduationAggs = applied.pool
  const rowsAll = graduationAggs.map(toRow)

  const negativeAggs = all.filter((a) => a.orders === 0 && a.costCents >= minSpendCents)
  const productNegatives = negativeAggs.filter((a) => isAsinQuery(a.query))
  const keywordNegatives = negativeAggs.filter((a) => !isAsinQuery(a.query))

  // ── the one-order view, computed over the same scope. This is the page's argument.
  //
  // 🔴 It holds every OTHER criterion at its current value and moves only `minOrders`, so the
  // "At 1+ order" link on the page lands on exactly the count the sentence promised. Computing it
  // over the raw set instead would make the link a lie the moment any other criterion was on.
  const oneOrder = applyCriteria(converted, { ...current, minOrders: 1 }).pool.filter((a) => !isAsinQuery(a.query)).map(toRow)
  const withoutKeywordInSource = oneOrder.filter((r) => r.status !== 'already-exact-here')
  const oneSpend = withoutKeywordInSource.reduce((s, r) => s + r.metrics.spendCents, 0)
  const oneSales = withoutKeywordInSource.reduce((s, r) => s + r.metrics.salesCents, 0)
  // ⚠️ The caveat as a number: which sale values are claimed by more than one term.
  const singles = withoutKeywordInSource.filter((r) => r.metrics.orders === 1)
  const valueCounts = new Map<number, number>()
  for (const r of singles) if (r.metrics.salesCents > 0) valueCounts.set(r.metrics.salesCents, (valueCounts.get(r.metrics.salesCents) ?? 0) + 1)
  const repeatedValues = [...valueCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([salesCents, terms]) => ({ salesCents, terms }))
    .sort((a, b) => b.terms - a.terms || b.salesCents - a.salesCents)

  const census: HvCensus = {
    candidates: rowsAll.length,
    byKind: {
      keyword: rowsAll.filter((r) => r.kind === 'keyword').length,
      product: rowsAll.filter((r) => r.kind === 'product').length,
    },
    newByKind: {
      keyword: rowsAll.filter((r) => r.kind === 'keyword' && r.status === 'new').length,
      product: rowsAll.filter((r) => r.kind === 'product' && r.status === 'new').length,
    },
    new: rowsAll.filter((r) => r.status === 'new').length,
    alreadyExactHere: rowsAll.filter((r) => r.status === 'already-exact-here').length,
    exactElsewhere: rowsAll.filter((r) => r.status === 'exact-elsewhere').length,
    localOnly: rowsAll.filter((r) => r.status === 'local-only').length,
    negatedAlready: rowsAll.filter((r) => r.negatedIn.rows > 0).length,
    exactMatchedOnly: rowsAll.filter((r) => r.exactMatchedOnly).length,
    atOneOrder: {
      candidates: oneOrder.length,
      withoutKeywordInSource: withoutKeywordInSource.length,
      noExactMatch: withoutKeywordInSource.filter((r) => !r.matchedVia.some((m) => m.matchType === 'EXACT')).length,
      spendCents: oneSpend,
      salesCents: oneSales,
      acosPct: oneSales > 0 ? (oneSpend / oneSales) * 100 : null,
      singleOrder: singles.length,
      repeatedValues,
    },
    // 🔴 HV.3 — the destination picture over the FULL candidate set, never a page of rows.
    destinations: {
      stored: rowsAll.filter((r) => r.destination?.source === 'stored').length,
      resolvedUnique: rowsAll.filter((r) => r.destination?.source === 'resolved-unique').length,
      ambiguous: rowsAll.filter((r) => r.destination?.source === 'resolved-ambiguous').length,
      none: rowsAll.filter((r) => !r.destination || r.destination.source === 'none').length,
      // The §4.1 coupling as two numbers: how many promotions would ALSO negate their source, and
      // how many would silently leave the discovery ad group competing for the same term.
      wouldNegate: rowsAll.filter((r) => r.destination?.wouldNegateAtSource).length,
      wouldNotNegate: rowsAll.filter((r) => r.destination && !r.destination.wouldNegateAtSource).length,
      wouldDuplicate: rowsAll.filter((r) => r.destination?.status === 'would-duplicate').length,
    },
    negativeCandidates: { count: keywordNegatives.length, spendCents: keywordNegatives.reduce((s, a) => s + a.costCents, 0) },
    productCandidates: { graduations: rowsAll.filter((r) => r.kind === 'product').length, negatives: productNegatives.length },
  }

  // ── facets over the candidate set BEFORE the row filters, so a filter that would empty the grid
  // says so on the control rather than by rendering nothing.
  const facets = {
    status: tally(rowsAll, (r) => r.status),
    kind: tally(rowsAll, (r) => r.kind),
    market: tally(rowsAll, (r) => r.market),
    targetingType: tally(rowsAll, (r) => (r.campaign.targetingType ?? 'unknown')),
    matchedVia: tally(rowsAll.flatMap((r) => r.matchedVia.map((m) => m.matchType)), (m) => m),
    destination: tally(rowsAll, (r) => (r.destination?.source ?? 'none')),
    destStatus: tally(rowsAll, (r) => (r.destination?.status ?? 'no-destination')),
  }

  // ── the row filters
  const needle = (req.q ?? '').trim().toLowerCase()
  let rows = rowsAll
  if (req.status && req.status !== 'all') rows = rows.filter((r) => r.status === req.status)
  if (req.kind && req.kind !== 'all') rows = rows.filter((r) => r.kind === req.kind)
  // HV.3 — `?dest=` filters by HOW the destination resolved, not by which one it is. "Show me
  // everything nobody has decided yet" is the question this page gets asked.
  if (req.dest && req.dest !== 'all') {
    rows = rows.filter((r) => {
      const s = r.destination?.source ?? 'none'
      return req.dest === 'proposed' ? (s === 'resolved-unique' || s === 'resolved-ambiguous')
        : req.dest === 'overridden' ? s === 'stored'
        : s === 'none'
    })
  }
  if (req.competing === true) rows = rows.filter((r) => r.destination?.status === 'would-duplicate')
  if (needle) rows = rows.filter((r) => `${r.term} ${r.campaign.name} ${r.adGroup.name}`.toLowerCase().includes(needle))

  const dir = req.dir === 'asc' ? 1 : -1
  const sortKey: HvSortKey = req.sort ?? 'orders'
  const num = (v: number | null) => (v == null ? Number.NEGATIVE_INFINITY : v)
  const cmp: Record<HvSortKey, (r: HarvestRow) => number | string> = {
    term: (r) => r.termKey,
    market: (r) => r.market,
    source: (r) => `${r.campaign.name} ${r.adGroup.name}`,
    impressions: (r) => r.metrics.impressions,
    clicks: (r) => r.metrics.clicks,
    spend: (r) => r.metrics.spendCents,
    orders: (r) => r.metrics.orders,
    sales: (r) => r.metrics.salesCents,
    acos: (r) => num(r.metrics.acosPct),
    cpc: (r) => num(r.metrics.cpcCents),
    status: (r) => r.status,
    negated: (r) => r.negatedIn.rows,
    kind: (r) => r.kind,
  }
  const pick = cmp[sortKey] ?? cmp.orders
  rows = [...rows].sort((a, b) => {
    const x = pick(a); const y = pick(b)
    if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * dir
    return (x - y) * dir
  })

  const total = rows.length
  const truncated = total > MAX_ROWS

  // ── freshness, computed. Never a constant.
  const st = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true, createdAt: true }, _count: true })
  const newest = st._max.date ?? null
  const ageDays = newest ? Math.floor((Date.now() - newest.getTime()) / 86_400_000) : null

  const line = req.line ? products.find((p) => p.id === req.line) as { id: string; sku?: string; name?: string } | undefined : undefined
  const pf = req.portfolio ? portfolios.find((p) => p.externalPortfolioId === req.portfolio) : undefined
  const cp = req.campaign ? campById.get(req.campaign) : undefined
  const ag = req.adGroup ? agById.get(req.adGroup) : undefined

  return {
    scope: {
      market: req.market,
      boundBy: scope.boundBy,
      line: line ? { id: line.id, name: `${line.sku ?? line.id}${line.name ? ` — ${line.name}` : ''}` } : null,
      portfolio: pf ? { id: pf.externalPortfolioId, name: pf.name } : null,
      campaign: cp ? { id: cp.id, name: cp.name } : null,
      adGroup: ag ? { id: ag.id, name: ag.name } : null,
      resolved: {
        campaigns: scope.campaignIds.length,
        campaignsInMarket: scope.campaignsInMarket,
        // 🔴 Reach, stated honestly (AUTO §11 C5): most campaigns have no search-term data at all
        // in this window, and a scope that says "220 campaigns" over a grid built from 64 is the
        // denominator bug this section has already shipped twice.
        campaignsWithTerms: new Set(all.map((a) => a.campaignId)).size,
        adGroups: new Set(all.map((a) => a.adGroupId)).size,
      },
      adGroupOptions: adGroupRows
        .filter((a) => scope.campaignIds.includes(a.campaignId))
        .map((a) => ({ id: a.id, name: a.name, campaignName: campById.get(a.campaignId)?.name ?? '', terms: termsByExtAdGroup.get(a.externalAdGroupId ?? '') ?? 0 }))
        .filter((a) => a.terms > 0)
        .sort((x, y) => y.terms - x.terms),
    },
    window: { days: windowDays, since: since.toISOString(), until: until.toISOString() },
    thresholds: { minOrders, minSpendEur },
    criteria: {
      inForce: { minOrders, minClicks, maxAcosPct, windowDays, excludeExactMatched },
      policy: {
        criteria: pc,
        source: policy.source,
        sourceScopeId: policy.sourceScopeId,
        hasOwn: policy.hasOwn,
        // What a Save would write to: the narrowest grain the operator actually picked. Not
        // `boundBy` — that is about which grain decided the ROWS, and the two differ whenever a
        // coarser grain is also selected.
        saveGrain: req.adGroup ? 'adGroup' : req.campaign ? 'campaign' : req.portfolio ? 'portfolio' : req.line ? 'line' : (req.market && req.market !== HV_MARKET_ALL) ? 'market' : 'account',
        saveScopeId: req.adGroup || req.campaign || req.portfolio || req.line || (req.market !== HV_MARKET_ALL ? req.market : null),
        updatedAt: policy.updatedAt,
        updatedBy: policy.updatedBy,
      },
      overridden,
    },
    attrition: {
      base: converted.length,
      baseLabel: `term${converted.length === 1 ? '' : 's'} that converted at least once in this scope`,
      steps: applied.steps,
    },
    freshness: {
      newestTermDate: newest ? newest.toISOString() : null,
      ageDays,
      newestRowWrittenAt: st._max.createdAt ? st._max.createdAt.toISOString() : null,
      rows: st._count,
    },
    census,
    facets,
    rows: rows.slice(0, MAX_ROWS),
    total,
    truncated,
  }
}
