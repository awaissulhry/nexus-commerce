/**
 * BID.S0 — the Bid page's one read.
 *
 * The page asks: **what is each target bidding, and what did that buy?** S0 answers the first half
 * over the whole account at two grains, which nothing in this product does today: the only grid
 * that shows a bid beside its evidence is `ads-console/rank/KeywordBidStation.tsx`, and you can
 * reach it solely by already knowing which campaign to open.
 *
 * Read-only. It moves no bid, stages nothing, and changes nothing at Amazon.
 *
 * ── Why this exists rather than `GET /advertising/targets` ──────────────────────────────────────
 *
 * That route is right for what it does — one campaign's keywords, with real metrics overlaid — and
 * wrong for this page, for four reasons measured 2026-08-12:
 *
 *   · it caps at `take: 2000` against **3,154** positive AdTarget rows, so 1,154 are unreachable;
 *   · it has **no `orderBy`**, so *which* 2,000 you get is whatever Postgres felt like;
 *   · it filters by a single `campaignId` and by nothing else — no market, portfolio, product line
 *     or status — so it cannot answer "the ENABLED keywords in DE";
 *   · it has no aggregate, so the campaign roll-up would have to be summed from a truncated page.
 *
 * NEG.1's route header makes the identical argument for negatives (2,059 rows against the same
 * 2,000 cap). Same shape of problem, same answer.
 *
 * ── 🔴 The number this page must not tell a lie about ───────────────────────────────────────────
 *
 * **Only 521 of 2,944 ENABLED positive targets (17.7%) carry any 30-day
 * `AmazonAdsDailyPerformance` row at all, and only 274 have a click or a cent of spend.**
 *
 * That is not missing data — 2,423 targets genuinely got no impressions in 30 days. But a grid
 * that renders `—` in five metric columns on 2,423 rows teaches an operator that the page is
 * broken, and the operator who learns that stops trusting the columns that *are* populated. So
 * `measured` is a first-class fact on every row, a facet you can filter by, and a census cell.
 * A row that was never served and a row that was served and earned nothing are different answers
 * to "why is this zero", and this service keeps them apart.
 *
 * 🔴 And never read `AdTarget.spendCents / clicks / salesCents / impressions`: they are **0 on all
 * 3,154 rows**. Every metric here comes from `AmazonAdsDailyPerformance` with
 * `entityType = 'AD_TARGET'`. Reading the denormalised columns gives a confident, entirely wrong
 * answer — it is what makes `bid_to_target_acos` propose nothing (page study §3).
 *
 * ── Scope resolves the way the GATE resolves it ─────────────────────────────────────────────────
 *
 * `resolveScopeReach` (ads-scope-reach.ts) is what the rule evaluator enforces with. This page
 * calls the same function rather than cascading its own grains, so "the campaigns this view is
 * showing you" and "the campaigns a rule scoped this way would reach" are the same set by
 * construction. The sibling pages each grew their own cascade; on a page whose later sections are
 * about rules as exceptions, agreeing with enforcement matters more than matching their prose.
 */

import prisma from '../../db.js'
import { resolveScopeReach } from './ads-scope-reach.js'
import { microsToCents } from '../ads-core/metrics-math.js'

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const BID_MARKETS = ['IT', 'DE', 'FR', 'ES'] as const
export const BID_MARKET_ALL = 'all'

export type BidView = 'targets' | 'campaigns'
export type BidStatusFilter = 'enabled' | 'paused' | 'archived' | 'all'
export type BidMeasured = 'yes' | 'no' | 'all'
export type BidBand = '0-5' | '6-20' | '21-50' | '51-100' | '100+'

export const BID_BANDS: readonly BidBand[] = ['0-5', '6-20', '21-50', '51-100', '100+'] as const

/**
 * Which band a bid falls in. Contiguous and total over the non-negative integers — every possible
 * `bidCents` lands in exactly one band, which is the property the test pins. A gap here would make
 * a row invisible to every band chip while still being counted by the census above them.
 *
 * The boundaries are the study's, and the bottom one is not arbitrary: 5¢ is `BID_FLOOR_CENTS` in
 * the rule handlers and `FLOOR_CENTS` in the optimiser, so "0-5" is exactly the population those
 * two consider already at the floor.
 */
export function bandOf(bidCents: number): BidBand {
  if (bidCents <= 5) return '0-5'
  if (bidCents <= 20) return '6-20'
  if (bidCents <= 50) return '21-50'
  if (bidCents <= 100) return '51-100'
  return '100+'
}

export interface BidGridRequest {
  market: string
  line: string | null
  portfolio: string | null
  campaign: string | null
  view: BidView
  status: BidStatusFilter
  kind: string[]
  match: string[]
  band: BidBand | null
  measured: BidMeasured
  q: string | null
  /** metric window in days — 7 | 30 | 60. NOT the history window; S3 owns that. */
  windowDays: number
  sort: string | null
  dir: 'asc' | 'desc'
  limit: number
}

/**
 * 🔴 256 of 3,154 targets (8.1%) carry an EMPTY `expressionValue`, and they hold €608.56 of 30-day
 * spend — 18% of the account's total. They are the auto-targeting groups (AUTO 175) and the
 * audience/category forms (PRODUCT_CATEGORY 32 · PRODUCT_AUDIENCE 28 · AUDIENCE 14 ·
 * PRODUCT_CATEGORY_AUDIENCE 7). None of them has a text expression, because none of them IS one:
 * a "substitutes" target is identified by its targeting group, exactly as Seller Central names it.
 *
 * Found by looking at the deployed grid, where 21 of the first 100 rows had a blank identity
 * column — including the 7th-largest spender on the page. A blank there is not cosmetic: that
 * column is the sort key, the search key, and the thing S3 will hang the bid curve off.
 *
 * Derived on the SERVER so the grid, the CSV export, the search and every later section say the
 * same words. `text` stays raw beside it, so a consumer can always tell a derived label from one
 * Amazon actually stores.
 */
const AUTO_GROUP_LABEL: Record<string, string> = {
  SEARCH_CLOSE_MATCH: 'Close match',
  SEARCH_LOOSE_MATCH: 'Loose match',
  PRODUCT_SUBSTITUTES: 'Substitutes',
  PRODUCT_COMPLEMENTS: 'Complements',
  SEARCH_RELATED_TO_YOUR_BRAND: 'Related to your brand',
  SEARCH_RELATED_TO_YOUR_LANDING_PAGES: 'Related to your landing pages',
  PRODUCT_SIMILAR: 'Similar products',
  PRODUCT_EXACT: 'Exact product',
}
const KIND_LABEL: Record<string, string> = {
  AUTO: 'Auto targeting',
  PRODUCT_CATEGORY: 'Category target',
  PRODUCT_CATEGORY_AUDIENCE: 'Category audience',
  PRODUCT_AUDIENCE: 'Product audience',
  AUDIENCE: 'Audience',
}

/** The row's identity. Never blank — but never invented precision either: where the match type
 *  says nothing (`UNKNOWN`, 53 rows) it falls back to the kind rather than guessing a group. */
export function labelFor(text: string | null, kind: string, match: string): { label: string; derived: boolean } {
  const t = (text ?? '').trim()
  if (t) return { label: t, derived: false }
  return { label: AUTO_GROUP_LABEL[match] ?? KIND_LABEL[kind] ?? kind.replace(/_/g, ' ').toLowerCase(), derived: true }
}

export interface BidTargetRow {
  id: string
  text: string
  /** `text` when Amazon stores one; otherwise the targeting group's name. Never blank. */
  label: string
  /** true when `label` was derived because there is no expression to show */
  derived: boolean
  kind: string
  match: string
  bidCents: number
  band: BidBand
  status: string
  adGroupId: string
  adGroupName: string
  campaignId: string
  campaignName: string
  campaignStatus: string
  market: string
  /**
   * 🔴 Target ENABLED **and** campaign ENABLED. An intersection, not a status.
   *
   * 217 campaigns hold an ENABLED target; only 83 of them are ENABLED campaigns. A bid sitting in
   * a paused campaign is not a bid — it enters no auction and no bidder will ever move it — and a
   * grid that renders it identically to a live one is the same mistake NEG.1 found on "blocking
   * now": counting a row that is switched on inside something switched off.
   */
  liveNow: boolean
  /** true when this target has at least one performance row in the window */
  measured: boolean
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  cpcCents: number | null
  acos: number | null
}

export interface BidCampaignRow {
  id: string
  name: string
  market: string
  status: string
  targets: number
  measured: number
  bidMinCents: number | null
  bidMaxCents: number | null
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  cpcCents: number | null
  acos: number | null
}

export interface BidFacet { value: string; count: number }

export interface BidGridResult {
  scope: {
    market: string
    /** campaigns the scope resolved to, or null when nothing was selected (the whole account) */
    campaigns: number | null
    total: number
    applied: string[]
    notes: string[]
    contradiction: string | null
  }
  view: BidView
  window: { days: number; since: string }
  census: {
    targets: number
    campaigns: number
    /** of `targets`, how many are ENABLED inside an ENABLED campaign */
    liveNow: number
    /** of `campaigns`, how many are ENABLED */
    liveCampaigns: number
    measured: number
    spendCents: number
  }
  facets: {
    kind: BidFacet[]
    match: BidFacet[]
    band: BidFacet[]
    measured: BidFacet[]
  }
  rows: BidTargetRow[] | BidCampaignRow[]
  total: number
  truncated: boolean
  cursor: BidCursor
  freshness: { newestTargetAt: string | null; newestBidLogAt: string | null; newestPerfDate: string | null }
}

export interface BidCursor {
  /** max(AdTarget.updatedAt) in scope — the ONLY signal that catches the unaudited hourly resync */
  targetsAt: string | null
  /** max(AdvertisingActionLog.createdAt) for AD_BID_UPDATE in scope — the audited writes */
  loggedAt: string | null
  /** rows in scope; a create or a delete moves neither timestamp */
  n: number
}

const HARD_CAP = 5000

const STATUS_ENUM: Record<Exclude<BidStatusFilter, 'all'>, 'ENABLED' | 'PAUSED' | 'ARCHIVED'> = {
  enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED',
}

/**
 * The campaign ids this request is about, or `null` for "the whole account".
 *
 * `null` and "every campaign id" are the same answer and a very different query: the account holds
 * 220 campaigns, and threading all 220 ids through an `IN` on every request to say "no filter" is
 * both slower and a lie waiting to happen the day a campaign is created between the two queries.
 */
async function resolveScope(req: BidGridRequest) {
  const unscoped = req.market === BID_MARKET_ALL && !req.line && !req.portfolio && !req.campaign
  if (unscoped) {
    const total = await prisma.campaign.count()
    return { campaignIds: null as string[] | null, total, applied: [] as string[], notes: [] as string[], contradiction: null as string | null }
  }
  const reach = await resolveScopeReach({
    marketplace: req.market === BID_MARKET_ALL ? null : req.market,
    portfolioId: req.portfolio,
    campaignId: req.campaign,
    productId: req.line,
  })
  return {
    campaignIds: reach.campaignIds,
    total: reach.total,
    applied: reach.applied,
    notes: reach.notes,
    contradiction: reach.contradiction ?? null,
  }
}

/** Count occurrences of a key over rows, as a descending facet list. */
function facet<T>(rows: T[], key: (r: T) => string): BidFacet[] {
  const m = new Map<string, number>()
  for (const r of rows) { const k = key(r); m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/**
 * Compare, with the direction applied INSIDE and the null rule outside it.
 *
 * 🔴 A null metric sorts last in BOTH directions, and that is why `sign` cannot be applied to the
 * comparator's result from outside. Caught by `_bid-s0-verify.mts` before this shipped: with
 * null-last written as `return 1` and the caller doing `sign * cmp(a, b)`, a descending sort by
 * ACoS flipped it to null-FIRST and the top of the grid was five rows of "—". "Unknown" is not
 * "worst", and 247 of the 521 measured targets have no sales, so this is the common case, not the
 * edge one.
 */
const cmp = (a: number | string | null, b: number | string | null, sign: number): number => {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return sign * (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)))
}

export async function getBidGrid(req: BidGridRequest): Promise<BidGridResult> {
  const since = new Date(Date.now() - req.windowDays * 86400_000)
  const scope = await resolveScope(req)

  // A scope that can never resolve returns the reason, not an empty grid. `resolveScopeReach`
  // already writes the sentence; repeating it in different words here would give the operator two
  // explanations for one refusal.
  const noCampaigns = scope.campaignIds != null && scope.campaignIds.length === 0

  const targets = noCampaigns ? [] : await prisma.adTarget.findMany({
    where: {
      isNegative: false,
      ...(req.status !== 'all' ? { status: STATUS_ENUM[req.status] } : {}),
      ...(scope.campaignIds ? { adGroup: { campaignId: { in: scope.campaignIds } } } : {}),
    },
    select: {
      id: true, expressionValue: true, expressionType: true, kind: true, bidCents: true, status: true,
      updatedAt: true,
      adGroup: {
        select: {
          id: true, name: true,
          campaign: { select: { id: true, name: true, marketplace: true, status: true } },
        },
      },
    },
    // An explicit order, unlike the route this replaces. Without one a cap is a random sample
    // wearing the clothes of a result set.
    orderBy: [{ bidCents: 'desc' }, { id: 'asc' }],
    take: HARD_CAP + 1,
  })

  const truncated = targets.length > HARD_CAP
  const capped = truncated ? targets.slice(0, HARD_CAP) : targets

  // ── metrics: AmazonAdsDailyPerformance, never the denormalised columns ────────────────────────
  const ids = capped.map((t) => t.id)
  const perf = ids.length ? await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'AD_TARGET', localEntityId: { in: ids }, date: { gte: since } },
    _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true },
  }) : []
  const pmap = new Map(perf.map((p) => [p.localEntityId, p]))

  const all: BidTargetRow[] = capped.map((t) => {
    const p = pmap.get(t.id)
    const spendCents = p ? microsToCents(p._sum.costMicros) : 0
    const salesCents = p ? (p._sum.sales7dCents ?? 0) : 0
    const clicks = p ? (p._sum.clicks ?? 0) : 0
    const c = t.adGroup.campaign
    const kind = t.kind || 'UNKNOWN'
    const match = t.expressionType || 'UNKNOWN'
    const { label, derived } = labelFor(t.expressionValue, kind, match)
    return {
      id: t.id,
      text: t.expressionValue,
      label,
      derived,
      kind,
      match,
      bidCents: t.bidCents,
      band: bandOf(t.bidCents),
      status: String(t.status),
      adGroupId: t.adGroup.id,
      adGroupName: t.adGroup.name,
      campaignId: c.id,
      campaignName: c.name,
      campaignStatus: String(c.status),
      market: c.marketplace ?? '—',
      liveNow: String(t.status) === 'ENABLED' && String(c.status) === 'ENABLED',
      measured: !!p,
      impressions: p ? (p._sum.impressions ?? 0) : 0,
      clicks,
      spendCents,
      salesCents,
      orders: p ? (p._sum.orders7d ?? 0) : 0,
      // 🔴 A ratio over an unmeasured row is not 0, it is unknown. Two different blanks, and the
      // grid renders them differently.
      cpcCents: clicks > 0 ? spendCents / clicks : null,
      acos: p && salesCents > 0 ? spendCents / salesCents : null,
    }
  })

  // ── the chip filters, each as its own predicate so the facets can leave one out ───────────────
  const needle = (req.q ?? '').trim().toLowerCase()
  const pKind = (r: BidTargetRow) => req.kind.length === 0 || req.kind.includes(r.kind)
  const pMatch = (r: BidTargetRow) => req.match.length === 0 || req.match.includes(r.match)
  const pBand = (r: BidTargetRow) => !req.band || r.band === req.band
  const pMeasured = (r: BidTargetRow) => req.measured === 'all' || (req.measured === 'yes' ? r.measured : !r.measured)
  // Searches the LABEL, not the raw text: otherwise the 256 rows with no expression are
  // unreachable by the one control an operator uses to find a row they can see on screen.
  const pQ = (r: BidTargetRow) => !needle
    || r.label.toLowerCase().includes(needle)
    || r.campaignName.toLowerCase().includes(needle)
    || r.adGroupName.toLowerCase().includes(needle)

  /**
   * Facets exclude their OWN dimension and apply every other one.
   *
   * The cheap alternative — count every facet over the unfiltered scope — produces chips that
   * cannot deliver their own number: with `kind=KEYWORD` picked, a `PRODUCT_EXACT 661` chip would
   * sit there offering 661 rows and return zero. A chip whose count and whose result disagree
   * teaches the operator that the counts are decorative, and that lesson is not recoverable.
   */
  const kindFacet = facet(all.filter((r) => pMatch(r) && pBand(r) && pMeasured(r) && pQ(r)), (r) => r.kind)
  const matchFacet = facet(all.filter((r) => pKind(r) && pBand(r) && pMeasured(r) && pQ(r)), (r) => r.match)
  const bandRows = all.filter((r) => pKind(r) && pMatch(r) && pMeasured(r) && pQ(r))
  const bandFacet = BID_BANDS.map((b) => ({ value: b, count: bandRows.filter((r) => r.band === b).length }))
  const measuredRows = all.filter((r) => pKind(r) && pMatch(r) && pBand(r) && pQ(r))
  const measuredFacet: BidFacet[] = [
    { value: 'yes', count: measuredRows.filter((r) => r.measured).length },
    { value: 'no', count: measuredRows.filter((r) => !r.measured).length },
  ]

  const filtered = all.filter((r) => pKind(r) && pMatch(r) && pBand(r) && pMeasured(r) && pQ(r))

  /**
   * The census counts the SCOPE, not the filtered set, and every clickable cell reproduces its own
   * number — the discipline NEG.1 found the hard way, by clicking two cells on production that
   * applied a filter their count did not match. `spend` carries no click for exactly that reason:
   * there is no filter that would return "the rows summing to €X", so it is a stat, not a button.
   */
  const census = {
    targets: all.length,
    campaigns: new Set(all.map((r) => r.campaignId)).size,
    liveNow: all.filter((r) => r.liveNow).length,
    liveCampaigns: new Set(all.filter((r) => r.campaignStatus === 'ENABLED').map((r) => r.campaignId)).size,
    measured: all.filter((r) => r.measured).length,
    spendCents: all.reduce((s, r) => s + r.spendCents, 0),
  }

  // ── the campaign roll-up ──────────────────────────────────────────────────────────────────────
  const rollUp = (): BidCampaignRow[] => {
    const m = new Map<string, BidCampaignRow>()
    for (const r of filtered) {
      let c = m.get(r.campaignId)
      if (!c) {
        c = {
          id: r.campaignId, name: r.campaignName, market: r.market, status: r.campaignStatus,
          targets: 0, measured: 0, bidMinCents: null, bidMaxCents: null,
          impressions: 0, clicks: 0, spendCents: 0, salesCents: 0, orders: 0, cpcCents: null, acos: null,
        }
        m.set(r.campaignId, c)
      }
      c.targets += 1
      if (r.measured) c.measured += 1
      c.bidMinCents = c.bidMinCents == null ? r.bidCents : Math.min(c.bidMinCents, r.bidCents)
      c.bidMaxCents = c.bidMaxCents == null ? r.bidCents : Math.max(c.bidMaxCents, r.bidCents)
      c.impressions += r.impressions
      c.clicks += r.clicks
      c.spendCents += r.spendCents
      c.salesCents += r.salesCents
      c.orders += r.orders
    }
    for (const c of m.values()) {
      // Recomputed from the sums, never averaged from the rows' own ratios. A mean of per-target
      // ACoS is not the campaign's ACoS, and on a page about money that difference is the point.
      c.cpcCents = c.clicks > 0 ? c.spendCents / c.clicks : null
      c.acos = c.salesCents > 0 ? c.spendCents / c.salesCents : null
    }
    return [...m.values()]
  }

  // ── sort ──────────────────────────────────────────────────────────────────────────────────────
  const sign = req.dir === 'asc' ? 1 : -1
  const targetSort: Record<string, (r: BidTargetRow) => number | string | null> = {
    target: (r) => r.label.toLowerCase(), match: (r) => r.match, kind: (r) => r.kind,
    adGroup: (r) => r.adGroupName.toLowerCase(), campaign: (r) => r.campaignName.toLowerCase(),
    market: (r) => r.market, bid: (r) => r.bidCents, impressions: (r) => r.impressions,
    clicks: (r) => r.clicks, cpc: (r) => r.cpcCents, spend: (r) => r.spendCents, acos: (r) => r.acos,
  }
  const campaignSort: Record<string, (r: BidCampaignRow) => number | string | null> = {
    campaign: (r) => r.name.toLowerCase(), market: (r) => r.market, targets: (r) => r.targets,
    bidRange: (r) => r.bidMaxCents, spend: (r) => r.spendCents, sales: (r) => r.salesCents, acos: (r) => r.acos,
  }

  let rows: BidTargetRow[] | BidCampaignRow[]
  if (req.view === 'campaigns') {
    const cr = rollUp()
    const f = req.sort ? campaignSort[req.sort] : null
    rows = f ? [...cr].sort((a, b) => cmp(f(a), f(b), sign)) : cr.sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name))
  } else {
    const f = req.sort ? targetSort[req.sort] : null
    rows = f ? [...filtered].sort((a, b) => cmp(f(a), f(b), sign)) : filtered
  }
  const total = rows.length
  if (rows.length > req.limit) rows = rows.slice(0, req.limit) as BidTargetRow[] | BidCampaignRow[]

  // ── freshness + the poll cursor ───────────────────────────────────────────────────────────────
  const cursor = await getBidCursor(scope.campaignIds, noCampaigns)
  const newestPerf = ids.length ? await prisma.amazonAdsDailyPerformance.findFirst({
    where: { entityType: 'AD_TARGET', localEntityId: { in: ids } },
    orderBy: { date: 'desc' }, select: { date: true },
  }) : null

  return {
    scope: {
      market: req.market,
      campaigns: scope.campaignIds ? scope.campaignIds.length : null,
      total: scope.total,
      applied: scope.applied,
      notes: scope.notes,
      contradiction: scope.contradiction,
    },
    view: req.view,
    window: { days: req.windowDays, since: since.toISOString() },
    census,
    facets: { kind: kindFacet, match: matchFacet, band: bandFacet, measured: measuredFacet },
    rows,
    total,
    truncated,
    cursor,
    freshness: {
      newestTargetAt: cursor.targetsAt,
      newestBidLogAt: cursor.loggedAt,
      newestPerfDate: newestPerf?.date?.toISOString() ?? null,
    },
  }
}

/**
 * The poll cursor. ~100 bytes, three cheap aggregates, no row payload — it is meant to be hit every
 * 45 seconds by every open tab, which the grid read is not.
 *
 * 🔴 **`AdTarget.updatedAt` is the load-bearing half, not the action log.** Measured 2026-08-12 at
 * 00:15 Rome: newest `AD_BID_UPDATE` log row `22:16:50Z`, newest `AdTarget.updatedAt` `00:10:08Z` —
 * **1h53m apart**. The gap is `ads-keyword-bid-resync`, the hourly inbound sync that overwrites
 * `bidCents` with Amazon's value and writes no audit row anywhere (page study §2, writer 9). A
 * cursor built on the audit spine alone would miss every bid change made in Seller Central and
 * every value Amazon disagrees with us about — which is precisely the class of change this page
 * exists to surface.
 *
 * `n` is the third field because neither timestamp moves when a row is created or deleted.
 *
 * Not SSE: the ads event bus carries 0.21% of writes and publishes nothing from the engines.
 */
export async function getBidCursor(campaignIds: string[] | null, noCampaigns = false): Promise<BidCursor> {
  if (noCampaigns) return { targetsAt: null, loggedAt: null, n: 0 }
  const targetWhere = {
    isNegative: false,
    ...(campaignIds ? { adGroup: { campaignId: { in: campaignIds } } } : {}),
  }
  const [newest, n, log] = await Promise.all([
    prisma.adTarget.findFirst({ where: targetWhere, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    prisma.adTarget.count({ where: targetWhere }),
    // Scoped by entity id rather than by campaign: the log stores AD_TARGET ids with no campaign
    // column, and resolving them back would cost more than the whole cursor. Account-wide is the
    // honest approximation here — it can only ever say "something moved" slightly too often, which
    // costs one refetch, whereas the other direction costs a stale grid.
    prisma.advertisingActionLog.findFirst({
      where: { actionType: 'AD_BID_UPDATE' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    }),
  ])
  return {
    targetsAt: newest?.updatedAt?.toISOString() ?? null,
    loggedAt: log?.createdAt?.toISOString() ?? null,
    n,
  }
}

/** The cursor endpoint's own scope resolution, so the poll and the grid agree about the row set. */
export async function getBidCursorForRequest(req: Pick<BidGridRequest, 'market' | 'line' | 'portfolio' | 'campaign'>): Promise<BidCursor> {
  const scope = await resolveScope({ ...req } as BidGridRequest)
  return getBidCursor(scope.campaignIds, scope.campaignIds != null && scope.campaignIds.length === 0)
}
