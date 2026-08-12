/**
 * PLC.0 — the Placement page's one read.
 *
 * One question: **for every campaign, in which lane are my ads showing, what is each lane worth,
 * and who put the multiplier there?**
 *
 * Read-only. It writes no multiplier, sets no pin, and calls Amazon not at all.
 *
 * ── Why this exists when `GET /advertising/campaigns/:id/placements` already does ─────────────
 *
 * That route is per-campaign and its main `groupBy` carries **no date filter at all**
 * (`advertising.routes.ts:575`), so it returns lifetime totals for one campaign you must already
 * know the id of. The question this page answers is account-wide and windowed. Nothing about the
 * two reads is the same except the table.
 *
 * ── Four things that live here as named functions, because each goes wrong silently ───────────
 *
 *   1. `REPORT_TO_BID_KEY` — the two-vocabulary join. See the block below; this is the one that
 *      has already produced a wrong hypothesis in this programme.
 *   2. `laneMultipliers`   — absent and 0 are the same thing to Amazon, and the grid says so.
 *   3. `ownerOf`           — schedule / plan / **nobody**. The most important column on the page.
 *   4. `weightedIS`        — an impression share is a ratio; summing days is meaningless.
 *
 * ── 🔴 The two-vocabulary trap ────────────────────────────────────────────────────────────────
 *
 * `Campaign.dynamicBidding.placementBidding` is keyed by the BIDDING API enums
 * (`PLACEMENT_TOP` · `PLACEMENT_REST_OF_SEARCH` · `PLACEMENT_PRODUCT_PAGE`, imported from
 * `ads-placement-math.ts` rather than retyped). `AmazonAdsPlacementReport.placement` holds
 * Amazon's REPORT labels (`Top of Search on-Amazon` · `Other on-Amazon` · `Detail Page
 * on-Amazon`). Matching the report on the enums returns nothing — not an error, a clean zero —
 * and a clean zero reads exactly like "this lane does not deliver". The map already exists inline
 * at `advertising.routes.ts:586`; the same three pairs are restated here because that file does
 * not export them and is ~600 KB of concurrent edits.
 *
 * ── 🔴 The join is on the EXTERNAL id ─────────────────────────────────────────────────────────
 *
 * `AmazonAdsPlacementReport.campaignId` is Amazon's id, not a local `Campaign.id`. Joining on the
 * local id returns zero rows for every campaign. (`localCampaignId` exists on the model but is
 * nullable and not what the ingest fills reliably — the external id is the key the unique
 * constraint is built on.)
 *
 * ── No `.catch(() => [])` anywhere in this file ───────────────────────────────────────────────
 *
 * A swallowed Prisma error returns `[]`, which renders as a measurement of zero and is
 * indistinguishable from "nothing is set". That pattern has produced three false findings in this
 * programme. If a query here fails, the request fails.
 */

import prisma from '../../db.js'
import { PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT } from './ads-placement-math.js'
import { resolveScopeReach } from './ads-scope-reach.js'
import { resolveRange, type RangePreset } from '../ads-core/date-range.js'
// The engine's own predicate for "this schedule is owned by the rank-defend loop", not a copy of
// it. `ad-dayparting.job.ts:16` already imports it for exactly this reason — two definitions of
// goal mode would let this page call a campaign governed that the engine never visits.
//
// Verified before importing (the module graph, not the name): `ad-rank-defend.job.ts` schedules no
// cron at module scope (`cron.schedule` is inside `startRankDefendCron`, :721) and its one
// side-effecting transitive import, `ads-top-of-search.service.ts` (which assigns
// `ACTION_HANDLERS.defend_top_of_search` at :228), is ALREADY in this routes file's graph via
// `ads-autopilot.service.ts:18`. So the import adds a name, not a behaviour.
import { isGoalMode } from '../../jobs/ad-rank-defend.job.js'

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const PLC_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

/**
 * `all` is a legitimate scope here, unlike on the Keyword Tracker.
 *
 * That page refuses it because market volume, rank and share are per-marketplace quantities with
 * no honest sum. Everything this page shows is either a per-campaign fact (a campaign belongs to
 * exactly one market) or a currency amount, and all four markets bill in EUR. A summed row is
 * unambiguous, and every row carries its own market.
 */
export const PLC_MARKET_ALL = 'all'

export type PlcLane = typeof PLACEMENT_TOP | typeof PLACEMENT_REST | typeof PLACEMENT_PRODUCT
export type PlcLaneKey = 'top' | 'rest' | 'product'
export type PlcOwnerKind = 'schedule' | 'plan' | 'none'
export type PlcGrain = 'market' | 'line' | 'portfolio' | 'campaign'

/** Display order, and the order the three rows of a campaign appear in when sorted by lane. */
export const PLC_LANES: readonly PlcLane[] = [PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT]

/** The URL vocabulary → the API enum. Chosen here; the shape is fixed by the substrate spec. */
export const LANE_BY_KEY: Record<PlcLaneKey, PlcLane> = {
  top: PLACEMENT_TOP,
  rest: PLACEMENT_REST,
  product: PLACEMENT_PRODUCT,
}
export const KEY_BY_LANE: Record<PlcLane, PlcLaneKey> = {
  [PLACEMENT_TOP]: 'top',
  [PLACEMENT_REST]: 'rest',
  [PLACEMENT_PRODUCT]: 'product',
}

/**
 * Amazon's REPORT label → the bidding-API enum. Exactly three distinct labels exist in this
 * account (verified 2026-08-11 and again by `_plc-page-basis.mts`); an unrecognised fourth is
 * dropped rather than guessed at, and the script counts what was dropped so a new Amazon label
 * shows up as a number instead of as missing spend.
 */
export const REPORT_TO_BID_KEY: Record<string, PlcLane> = {
  'Top of Search on-Amazon': PLACEMENT_TOP,
  'Other on-Amazon': PLACEMENT_REST,
  'Detail Page on-Amazon': PLACEMENT_PRODUCT,
}

export type PlcSortKey =
  | 'campaign' | 'market' | 'status' | 'lane' | 'multiplier'
  | 'impressions' | 'clicks' | 'spend' | 'roas' | 'cpc' | 'cvr' | 'is' | 'owner'

export const PLC_SORT_KEYS: readonly PlcSortKey[] = [
  'campaign', 'market', 'status', 'lane', 'multiplier',
  'impressions', 'clicks', 'spend', 'roas', 'cpc', 'cvr', 'is', 'owner',
]

export interface PlcRequest {
  market: string
  line: string | null
  portfolio: string | null
  campaign: string | null
  /** server vocabulary only — a picker key never reaches here (substrate spec §1.2.5) */
  preset: string | null
  start: string | null
  end: string | null
  lane: PlcLaneKey | 'all'
  q: string | null
  sort: PlcSortKey | null
  dir: 'asc' | 'desc'
}

export interface PlcRow {
  campaignId: string
  name: string
  marketplace: string | null
  status: string
  adProduct: string | null
  biddingStrategy: string | null
  lane: PlcLane
  laneKey: PlcLaneKey
  /** 0 when the lane is absent — absent and 0 are the same thing to Amazon */
  multiplierPct: number
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  /** derived server-side so the sort and the cell can never disagree; null where undefined */
  roas: number | null
  cpc: number | null
  cvr: number | null
  /** TOP lane only. null on Rest/Product is CORRECT — Amazon publishes none for those lanes. */
  topOfSearchIS: number | null
  /** how many days in the window carried a top-of-search share, so the number states its basis */
  topOfSearchISDays: number
  owner: PlcOwnerKind
  /** the RankScheduleGroup name (schedule) or the family's parent product (plan); null for none */
  ownerLabel: string | null
  /** false ⇒ "no delivery in this window", which is not zero */
  hasReportRow: boolean
}

export interface PlcPayload {
  scope: {
    market: string
    boundBy: PlcGrain
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    /** what `resolveScopeReach` said it applied, and anything it wants the operator to know */
    applied: string[]
    notes: string[]
    contradiction: string | null
    totalCampaigns: number
  }
  range: { preset: RangePreset; start: string; end: string; days: number; includesToday: boolean }
  /**
   * MAX(AmazonAdsPlacementReport.date) over the campaigns in scope, **deliberately not bounded by
   * the window**: this states how fresh the feed is, not how fresh the slice you asked for is. A
   * window-bounded max would print the end of a historical range and read as "current".
   */
  dataThrough: string | null
  counts: {
    campaigns: number
    /** 🔴 hour-dependent — see `engine` below and the block above `readEngineReceipt` */
    carrying: number
    /** 🔴 hour-dependent for the same reason: it is `carrying` ∩ governed */
    governed: number
    /** stable: nothing steers these, so nothing moves them */
    unmanaged: number
    /** campaigns an engine governs, whatever they happen to carry this hour. NOT hour-dependent. */
    governedTotal: number
    withReportRow: number
    carryingNoReportRow: number
  }
  engine: PlcEngineReceipt
  lane: PlcLaneKey | 'all'
  rows: PlcRow[]
  total: number
}

// ── the lever ─────────────────────────────────────────────────────────────────────────────────

interface PlacementBid { placement: string; percentage: number }

/**
 * The three lanes a campaign carries, always all three.
 *
 * A lane absent from `placementBidding` and a lane present at 0 are **the same instruction to
 * Amazon** — no bid adjustment on that placement. The grid renders both as 0 and says so; what it
 * must never do is drop the row, because the absence of a multiplier on the lane that earns most
 * is the finding, not a gap in the data.
 */
export function laneMultipliers(dynamicBidding: unknown): Record<PlcLane, number> {
  const db = (dynamicBidding ?? {}) as { placementBidding?: PlacementBid[] }
  const list = Array.isArray(db.placementBidding) ? db.placementBidding : []
  const out = {
    [PLACEMENT_TOP]: 0,
    [PLACEMENT_REST]: 0,
    [PLACEMENT_PRODUCT]: 0,
  } as Record<PlcLane, number>
  for (const p of list) {
    if (!p || typeof p.placement !== 'string') continue
    if (p.placement in out) out[p.placement as PlcLane] = Number(p.percentage) || 0
  }
  return out
}

/**
 * An impression share is a ratio, so days are averaged and never summed — weighted by that day's
 * impressions, because a day that served 4 impressions should not move the number as far as one
 * that served 4,000. When every weight is 0 (a day with a share and no impressions is possible in
 * Amazon's feed) it falls back to the plain mean rather than dividing by zero.
 */
export function weightedIS(points: Array<{ value: number; weight: number }>): number | null {
  if (points.length === 0) return null
  const w = points.reduce((s, p) => s + p.weight, 0)
  if (w > 0) return points.reduce((s, p) => s + p.value * p.weight, 0) / w
  return points.reduce((s, p) => s + p.value, 0) / points.length
}

/** micros → cents. `costMicros` is a BigInt; Number() on it is safe at this account's magnitudes. */
const microsToCents = (v: bigint | number | null | undefined): number =>
  Math.round(Number(v ?? 0) / 10_000)

// ── scope ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Which campaigns this request is about, or `null` for "the whole account".
 *
 * Routed through `resolveScopeReach` — the resolver the rule evaluator enforces with — rather than
 * a fourth private copy. A page that resolves scope its own way is answering a different question
 * from the one the write gate answers, and the two would drift on the first schema change.
 */
async function resolveScope(req: PlcRequest) {
  const unscoped = req.market === PLC_MARKET_ALL && !req.line && !req.portfolio && !req.campaign
  if (unscoped) {
    const total = await prisma.campaign.count()
    return {
      campaignIds: null as string[] | null,
      total,
      applied: [] as string[],
      notes: [] as string[],
      contradiction: null as string | null,
    }
  }
  const reach = await resolveScopeReach({
    marketplace: req.market === PLC_MARKET_ALL ? null : req.market,
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

const boundByOf = (req: PlcRequest): PlcGrain =>
  req.campaign ? 'campaign' : req.portfolio ? 'portfolio' : req.line ? 'line' : 'market'

// ── ownership ─────────────────────────────────────────────────────────────────────────────────

export interface PlcOwnership {
  /** campaign id → what governs it, and what to call that thing */
  byCampaign: Map<string, { kind: Exclude<PlcOwnerKind, 'none'>; label: string | null }>
  enabledGoalSchedules: number
  enabledPlans: number
  receipt: PlcEngineReceipt
}

/**
 * 🔴 What the engine STAMPED, never a second resolver.
 *
 * `AdSchedule.lastApplied` is a receipt the rank-defend loop writes after it has decided
 * (`ad-rank-defend.job.ts:686-698`). Reading it is not the same thing as re-deriving which target
 * governs this hour — that is `resolveActiveTargetKey`, which the substrate owns and this page
 * must never fork (substrate spec §4, §8.7). One is a fact the engine recorded; the other is a
 * second opinion about the same question, free to drift.
 *
 * ── Why this is on the page at all, and not a nicety ─────────────────────────────────────────
 *
 * Measured 2026-08-12 at 02:56 Europe/Rome: **all 33 live goal-mode schedules held `pause`**, and
 * `pause.biasPct` is 0. Between 22:06 and 22:16 the night before, the engine wrote 40 lanes from
 * 375%, 102%, 98%, 75%, 60% down to **0**, each reasoned `rank — Min bid placement N→0%`. So 32
 * of the 33 governed campaigns carry no multiplier on any lane at this hour, and carried one
 * eight hours earlier.
 *
 * The consequence for every count on this page: **"carrying a multiplier" is a time-of-day
 * reading for the governed set.** The PLC study measured 167 carrying / 23 governed at ~13:00;
 * the identical code measures 145 / 1 at 02:56. Neither is wrong. A page that printed only the
 * number would read as instability — which is exactly what substrate spec §10.3 warns about — so
 * the number is printed with the plan behind it.
 *
 * `unmanaged` does NOT move, and that is the tell: nothing steers those 144 campaigns, so nothing
 * changes them. It measured 144 in the study and 144 here, with the same 103 PAUSED · 40 ENABLED
 * · 1 ARCHIVED split.
 */
export interface PlcEngineReceipt {
  goalSchedules: number
  enabledPlans: number
  /** `AdSchedule.lastApplied` tallied — what the engine recorded holding, most-held first */
  holding: Array<{ targetKey: string; campaigns: number }>
  /** newest `AdSchedule.lastEvaluatedAt` — when the loop last looked */
  lastEvaluatedAt: string | null
  /** governed campaigns carrying 0 on every lane right now */
  governedAtZero: number
}

/**
 * Who is steering each campaign's placement — the column this page exists for.
 *
 * Precedence is the engine's: **a plan beats a schedule**, because `ad-rank-defend.job.ts:669`
 * skips a schedule whose campaign is already plan-governed. Getting that backwards would name the
 * wrong owner on exactly the campaigns where two things could disagree.
 *
 * ⚠ Two traps in resolving the label, both measured 2026-08-11:
 *   · `automation:rank-defend-<id>` carries an **AdSchedule.id**, not a `RankScheduleGroup.id` —
 *     33 distinct actor ids against 16 groups, so a direct group lookup returns nothing. The hop
 *     is AdSchedule → `groupId` → RankScheduleGroup.
 *   · `RankScheduleGroup.marketplace` is **null**, so a market may never be read off a group. This
 *     function reads only the name.
 */
export async function resolveOwnership(): Promise<PlcOwnership> {
  const schedules = await prisma.adSchedule.findMany({
    where: { enabled: true },
    select: {
      id: true, campaignId: true, name: true, groupId: true, windows: true, defaultTargetKey: true,
      lastApplied: true, lastEvaluatedAt: true,
    },
  })
  const goal = schedules.filter((s) => isGoalMode(s.windows, s.defaultTargetKey))

  const groupIds = [...new Set(goal.map((s) => s.groupId).filter((x): x is string => !!x))]
  const groups = groupIds.length
    ? await prisma.rankScheduleGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } })
    : []
  const groupName = new Map(groups.map((g) => [g.id, g.name]))

  const byCampaign: PlcOwnership['byCampaign'] = new Map()
  for (const s of goal) {
    // A schedule with no group still has a name of its own; falling back to it beats printing
    // "schedule" with nothing after it.
    byCampaign.set(s.campaignId, { kind: 'schedule', label: (s.groupId ? groupName.get(s.groupId) : null) ?? s.name ?? null })
  }

  // 2 plan rows exist and 0 are enabled today. The branch is written and exercised anyway: the
  // moment one is enabled it takes precedence over every schedule it overlaps, and a page that
  // assumed "no plans" would name the wrong owner without changing a line of its own code.
  const plans = await prisma.productRankPlan.findMany({ where: { enabled: true } })
  if (plans.length > 0) {
    // Dynamic, and only when a plan exists: `ads-dayparting-refresh.service.ts` assigns
    // `ACTION_HANDLERS.refresh_dayparting` at module scope (:265), and a read path must not
    // register a rule action handler as a side effect of being imported. This is the same
    // dynamic import, for the same reason, that `ad-rank-defend.job.ts:452` uses.
    const { resolveProductFamily } = await import('./ads-dayparting-refresh.service.js')
    for (const plan of plans) {
      const fam = await resolveProductFamily({ parentProductId: plan.productId, marketplace: plan.marketplace })
      const excluded = new Set<string>(Array.isArray(plan.excludeCampaignIds) ? (plan.excludeCampaignIds as string[]) : [])
      const label = fam.parentName ?? plan.parentAsin ?? null
      for (const c of fam.campaigns ?? []) {
        if (excluded.has(c.id)) continue
        byCampaign.set(c.id, { kind: 'plan', label })
      }
    }
  }

  // The receipt, tallied from what the engine stamped. `governedAtZero` is filled by the caller,
  // which is the only place that has already read the campaigns' current lanes.
  const held = new Map<string, number>()
  for (const s of goal) held.set(String(s.lastApplied ?? 'nothing due'), (held.get(String(s.lastApplied ?? 'nothing due')) ?? 0) + 1)
  const newest = goal.map((s) => s.lastEvaluatedAt).filter((d): d is Date => !!d).sort((a, b) => +b - +a)[0]

  return {
    byCampaign,
    enabledGoalSchedules: goal.length,
    enabledPlans: plans.length,
    receipt: {
      goalSchedules: goal.length,
      enabledPlans: plans.length,
      holding: [...held.entries()]
        .map(([targetKey, campaigns]) => ({ targetKey, campaigns }))
        .sort((a, b) => b.campaigns - a.campaigns || a.targetKey.localeCompare(b.targetKey)),
      lastEvaluatedAt: newest ? newest.toISOString() : null,
      governedAtZero: 0,
    },
  }
}

// ── sort ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Compare with the direction applied INSIDE, and the null rule outside it.
 *
 * A null metric sorts last in BOTH directions. 113 of the 167 campaigns carrying a multiplier have
 * no report row at all, so "no delivery" is the common case here, not the edge one — and
 * descending by ROAS must not open with a screen of "—".
 */
const cmp = (a: number | string | null, b: number | string | null, sign: number): number => {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return sign * (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)))
}

const sortValue = (r: PlcRow, key: PlcSortKey): number | string | null => {
  switch (key) {
    case 'campaign': return r.name
    case 'market': return r.marketplace ?? ''
    case 'status': return r.status
    case 'lane': return PLC_LANES.indexOf(r.lane)
    case 'multiplier': return r.multiplierPct
    case 'impressions': return r.impressions
    case 'clicks': return r.clicks
    case 'spend': return r.spendCents
    case 'roas': return r.roas
    case 'cpc': return r.cpc
    case 'cvr': return r.cvr
    case 'is': return r.topOfSearchIS
    case 'owner': return r.owner
  }
}

// ── the read ──────────────────────────────────────────────────────────────────────────────────

export async function getPlacementGrid(req: PlcRequest): Promise<PlcPayload> {
  const range = resolveRange({
    preset: req.preset ?? undefined,
    startDate: req.start ?? undefined,
    endDate: req.end ?? undefined,
    // Absent preset and absent dates → 30 days. Stated once, here, so "the documented default"
    // is a line of code rather than a convention.
    windowDays: req.preset || (req.start && req.end) ? undefined : 30,
  })

  const scope = await resolveScope(req)
  const noCampaigns = scope.campaignIds != null && scope.campaignIds.length === 0

  const campaigns = noCampaigns ? [] : await prisma.campaign.findMany({
    where: scope.campaignIds ? { id: { in: scope.campaignIds } } : {},
    select: {
      id: true, name: true, marketplace: true, status: true, adProduct: true,
      biddingStrategy: true, externalCampaignId: true, dynamicBidding: true,
    },
    orderBy: { name: 'asc' },
  })

  // The name filter is applied to the CAMPAIGN before the lanes are expanded, so a search always
  // returns whole campaigns (three rows) rather than an arbitrary subset of one campaign's lanes.
  const needle = (req.q ?? '').trim().toLowerCase()
  const matched = needle ? campaigns.filter((c) => c.name.toLowerCase().includes(needle)) : campaigns

  const extIds = [...new Set(matched.map((c) => c.externalCampaignId).filter((x): x is string => !!x))]

  // Every read below is unguarded on purpose — see the file header. A swallowed failure here
  // would render as "this account spends nothing on placement", which is a sentence no operator
  // should ever be shown by accident.
  const [perf, isRows, freshest] = await Promise.all([
    extIds.length ? prisma.amazonAdsPlacementReport.groupBy({
      by: ['campaignId', 'placement'],
      where: { campaignId: { in: extIds }, date: { gte: range.since, lte: range.until } },
      _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
    }) : Promise.resolve([]),
    // Per-day rows, not a groupBy: a share has to be averaged over the days that carry one, and
    // an aggregate cannot weight what it has already collapsed.
    extIds.length ? prisma.amazonAdsPlacementReport.findMany({
      where: { campaignId: { in: extIds }, date: { gte: range.since, lte: range.until }, topOfSearchIS: { not: null } },
      select: { campaignId: true, impressions: true, topOfSearchIS: true },
    }) : Promise.resolve([]),
    extIds.length ? prisma.amazonAdsPlacementReport.aggregate({
      where: { campaignId: { in: extIds } },
      _max: { date: true },
    }) : Promise.resolve({ _max: { date: null } } as { _max: { date: Date | null } }),
  ])

  // report label → lane, per external campaign id
  const metrics = new Map<string, { impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number }>()
  let unmappedLabelRows = 0
  for (const p of perf) {
    const lane = REPORT_TO_BID_KEY[p.placement]
    if (!lane) { unmappedLabelRows += 1; continue }
    const k = `${p.campaignId}|${lane}`
    const cur = metrics.get(k) ?? { impressions: 0, clicks: 0, spendCents: 0, salesCents: 0, orders: 0 }
    cur.impressions += p._sum.impressions ?? 0
    cur.clicks += p._sum.clicks ?? 0
    cur.spendCents += microsToCents(p._sum.costMicros)
    cur.salesCents += p._sum.sales7dCents ?? 0
    cur.orders += p._sum.orders7d ?? 0
    metrics.set(k, cur)
  }

  const isByCampaign = new Map<string, Array<{ value: number; weight: number }>>()
  for (const r of isRows) {
    if (r.topOfSearchIS == null) continue
    const list = isByCampaign.get(r.campaignId) ?? []
    list.push({ value: Number(r.topOfSearchIS), weight: r.impressions ?? 0 })
    isByCampaign.set(r.campaignId, list)
  }

  const ownership = await resolveOwnership()

  // ── expand: one row per campaign per lane, always three ────────────────────────────────────
  const rows: PlcRow[] = []
  for (const c of matched) {
    const mult = laneMultipliers(c.dynamicBidding)
    const own = ownership.byCampaign.get(c.id)
    const isPoints = c.externalCampaignId ? isByCampaign.get(c.externalCampaignId) : undefined
    for (const lane of PLC_LANES) {
      const m = c.externalCampaignId ? metrics.get(`${c.externalCampaignId}|${lane}`) : undefined
      const impressions = m?.impressions ?? 0
      const clicks = m?.clicks ?? 0
      const spendCents = m?.spendCents ?? 0
      const salesCents = m?.salesCents ?? 0
      const orders = m?.orders ?? 0
      rows.push({
        campaignId: c.id,
        name: c.name,
        marketplace: c.marketplace,
        status: c.status,
        adProduct: c.adProduct,
        biddingStrategy: c.biddingStrategy,
        lane,
        laneKey: KEY_BY_LANE[lane],
        multiplierPct: mult[lane],
        impressions,
        clicks,
        spendCents,
        salesCents,
        orders,
        roas: spendCents > 0 ? salesCents / spendCents : null,
        cpc: clicks > 0 ? spendCents / clicks : null,
        cvr: clicks > 0 ? orders / clicks : null,
        // Top only. A blank on Rest or Product is a permanent property of Amazon's reporting, not
        // a gap in ours, and the column says which.
        topOfSearchIS: lane === PLACEMENT_TOP ? weightedIS(isPoints ?? []) : null,
        topOfSearchISDays: lane === PLACEMENT_TOP ? (isPoints?.length ?? 0) : 0,
        owner: own?.kind ?? 'none',
        ownerLabel: own?.label ?? null,
        hasReportRow: m != null,
      })
    }
  }

  // ── counts, over the resolved scope and BEFORE the lane filter ─────────────────────────────
  // The lane filter narrows what you are looking at; it does not change how many campaigns carry
  // a multiplier. A count that moved when you clicked "Top" would be answering a different
  // question from the one its label asks.
  const carrying = matched.filter((c) => {
    const m = laneMultipliers(c.dynamicBidding)
    return PLC_LANES.some((l) => m[l] > 0)
  })
  const withReport = new Set(
    matched.filter((c) => c.externalCampaignId && PLC_LANES.some((l) => metrics.has(`${c.externalCampaignId}|${l}`))).map((c) => c.id),
  )
  const governedInScope = matched.filter((c) => ownership.byCampaign.has(c.id))
  const counts = {
    campaigns: matched.length,
    carrying: carrying.length,
    governed: carrying.filter((c) => ownership.byCampaign.has(c.id)).length,
    unmanaged: carrying.filter((c) => !ownership.byCampaign.has(c.id)).length,
    // The stable companion to `governed`. A governed campaign holding `pause` carries nothing and
    // is still governed; without this number the page would say "1 governed" at 03:00 and "23" at
    // 13:00 with no way for the operator to tell that from a data fault.
    governedTotal: governedInScope.length,
    withReportRow: withReport.size,
    carryingNoReportRow: carrying.filter((c) => !withReport.has(c.id)).length,
  }
  const engine: PlcEngineReceipt = {
    ...ownership.receipt,
    governedAtZero: governedInScope.filter((c) => {
      const m = laneMultipliers(c.dynamicBidding)
      return PLC_LANES.every((l) => m[l] === 0)
    }).length,
  }

  // ── filter + sort ──────────────────────────────────────────────────────────────────────────
  const laneFiltered = req.lane === 'all' ? rows : rows.filter((r) => r.laneKey === req.lane)
  const key: PlcSortKey = req.sort ?? 'spend'
  const sign = req.dir === 'asc' ? 1 : -1
  const sorted = [...laneFiltered].sort((a, b) => {
    const primary = cmp(sortValue(a, key), sortValue(b, key), sign)
    if (primary !== 0) return primary
    // A stable, meaningful tie-break: a campaign's three lanes stay in Top → Rest → Product order
    // inside an equal-valued block, so 113 campaigns with no delivery do not shuffle on reload.
    return a.name.localeCompare(b.name) || PLC_LANES.indexOf(a.lane) - PLC_LANES.indexOf(b.lane)
  })

  // ── the scope's own names, for the sentence the page prints ────────────────────────────────
  const [lineRow, portfolioRow, campaignRow] = await Promise.all([
    req.line ? prisma.product.findUnique({ where: { id: req.line }, select: { id: true, sku: true, name: true } }) : Promise.resolve(null),
    req.portfolio ? prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: req.portfolio }, select: { externalPortfolioId: true, name: true } }) : Promise.resolve(null),
    req.campaign ? prisma.campaign.findUnique({ where: { id: req.campaign }, select: { id: true, name: true } }) : Promise.resolve(null),
  ])

  const notes = [...scope.notes]
  if (unmappedLabelRows > 0) {
    // A fourth Amazon label would otherwise vanish as missing spend. Say the number.
    notes.push(`${unmappedLabelRows} report row(s) in this window carry a placement label this page does not map to a lane, and are not counted`)
  }

  return {
    scope: {
      market: req.market,
      boundBy: boundByOf(req),
      line: lineRow ? { id: lineRow.id, name: `${lineRow.sku} — ${lineRow.name}` } : null,
      portfolio: portfolioRow ? { id: portfolioRow.externalPortfolioId, name: portfolioRow.name } : null,
      campaign: campaignRow ? { id: campaignRow.id, name: campaignRow.name } : null,
      applied: scope.applied,
      notes,
      contradiction: scope.contradiction,
      totalCampaigns: scope.total,
    },
    range: {
      preset: range.preset,
      start: range.sinceStr,
      end: range.untilStr,
      days: range.days,
      includesToday: range.includesToday,
    },
    dataThrough: freshest._max.date ? freshest._max.date.toISOString().slice(0, 10) : null,
    counts,
    engine,
    lane: req.lane,
    rows: sorted,
    total: sorted.length,
  }
}
