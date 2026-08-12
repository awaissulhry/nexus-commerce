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
// 🔴 The engine's own band, and the engine's own strategy headroom. Both IMPORTED. A second copy
// of `biasBand` is how this programme spent a day believing the rank loop chases when it pins, and
// a retyped `2` for up-and-down headroom would silently outlive the day the engine changes it.
import { biasBand, strategyHeadroom, type RankTargetSpec } from './rank-controller.js'
// The per-scope override merge, exported from the job for exactly this reason. PLC.0 already
// proved this module's import graph is side-effect-safe (no cron at module scope; its one
// side-effecting transitive import is already in the routes file's graph) and imports `isGoalMode`
// from it — that proof is reused here rather than re-litigated.
import { applyTargetOverrides } from '../../jobs/ad-rank-defend.job.js'
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

/**
 * The timezone rank windows are painted and resolved in. `AdSchedule.timezone` defaults to this
 * and every live row carries it; the engine reads it per schedule (`ad-rank-defend.job.ts:668`).
 * Stated here so the page can name the timezone it is reporting an hour in rather than implying
 * the reader's own.
 */
export const RANK_TZ = 'Europe/Rome'

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
  /** PLC.1 — the flag filter. `?row=` and `?drawer=` stay reserved for P2. */
  flag: PlcFlagKey | 'all'
  q: string | null
  sort: PlcSortKey | null
  dir: 'asc' | 'desc'
}

export type PlcFlagKey = 'inverted' | 'compounding' | 'unmanaged' | 'decorative'
export const PLC_FLAG_KEYS: readonly PlcFlagKey[] = ['inverted', 'compounding', 'unmanaged', 'decorative']

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
  /**
   * PLC.1 — campaign-level verdicts, repeated on each of the campaign's three rows.
   *
   * They are campaign-level because that is what they are ABOUT: an inversion is a statement about
   * a campaign's lanes relative to each other and cannot be evaluated one row at a time. `?flag=`
   * therefore filters campaigns and returns all their lanes, because a lane you cannot see beside
   * the others is not evidence.
   *
   * The one exception is the `unmanaged` CHIP, which the client still renders per-lane — "this
   * lane carries a multiplier nobody steers" is more precise than repeating it three times. The
   * flag and the census count campaigns; the chip points at the lane.
   */
  flags: PlcRowFlags
}

export interface PlcRowFlags {
  /** ≥2 lanes cleared `INVERSION_MIN_CLICKS` in this window, so a ROAS is allowed to decide */
  invertedEvaluable: boolean
  /** null unless inverted — carries the evidence so the chip states it rather than asserting */
  inversion: (PlcInversion & { paidLaneKey: PlcLaneKey; bestLaneKey: PlcLaneKey }) | null
  compounding: boolean
  /** worst case Amazon can charge against the base bid, from `STRATEGY_HEADROOM` */
  compoundingMultiple: number
  unmanaged: boolean
  /** the reachable targets whose goal the controller cannot read; empty when none */
  decorative: PlcDecorative[]
  /** the reachable targets that CAN move — so the chip can say what the plan *can* do */
  chaseable: PlcChaseable[]
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
    /** the resolved SCOPE. Never moved by `?q=` — see the block above the needle. */
    campaigns: number
    /** what `?q=` left of it. The only count the search touches. */
    matchedCampaigns: number
    /** 🔴 hour-dependent — see `engine` below */
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
  /** PLC.1 — every flag with the population it was computed over. Never a bare count. */
  flags: PlcFlagCounts
  /** PLC.1 — the scope's three lanes, share of impressions and of spend, recomputed each read */
  lanes: PlcLaneTotal[]
  /** PLC.1 — the poll cursor this payload was read with; hand it back to `useCursorPoll` */
  cursor: PlcCursor
  lane: PlcLaneKey | 'all'
  flag: PlcFlagKey | 'all'
  rows: PlcRow[]
  total: number
}

export interface PlcFlagCounts {
  inverted: { n: number; of: number; minClicks: number; engineMaintained: number }
  compounding: { n: number; of: number }
  unmanaged: { n: number; of: number; live: number; paused: number; archived: number }
  decorative: { n: number; of: number; withRealCeiling: number; allOutOnly: number; noneCanChase: number }
}

export interface PlcLaneTotal {
  laneKey: PlcLaneKey
  lane: PlcLane
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  impressionsPct: number | null
  spendPct: number | null
  roas: number | null
  cpc: number | null
  cvr: number | null
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

// ── PLC.1 · the flags ─────────────────────────────────────────────────────────────────────────
//
// Four opinions, each with its denominator. A flag with no denominator is the defect class this
// programme keeps finding: "0 inverted" over a 7-day window is "we could not check" wearing the
// words of "we checked". Every count below therefore ships with the population it was computed
// over, and the UI is required to print it.

/**
 * 🔴 How much traffic a lane needs before its ROAS is allowed to decide something.
 *
 * The study's 8 inversions were found over **60 days**, from **18 evaluable campaigns of 220**.
 * Over a 7-day window almost nothing clears this bar — which is the point: the honest answer then
 * is "not enough traffic to judge", never "0 inverted".
 */
export const INVERSION_MIN_CLICKS = 20

export interface PlcLaneScore {
  lane: PlcLane
  multiplierPct: number
  clicks: number
  roas: number | null
}

export interface PlcInversion {
  /** the lane carrying the highest multiplier AMONG the lanes with enough traffic to judge */
  paidLane: PlcLane
  paidPct: number
  paidRoas: number
  /** the best-returning lane among the same set */
  bestLane: PlcLane
  bestPct: number
  bestRoas: number
}

/**
 * 🔴 The money on this page: the highest multiplier sits on a lane a better-returning lane beats.
 *
 * Measured 2026-08-11 over 60 days: **18 campaigns evaluable, 8 inverted** (study §4.4). Two of
 * the eight are the ENGINE's doing — `IT-AIREON-SP-*` sit at Rest 45% because that is
 * `rest-of-search.biasPct`, pinned every 15 minutes, while their Top lane at 0% returns 4.17×. So
 * the verdict alone is not actionable; the caller pairs it with `owner` to decide whether the fix
 * is here or on Rank & Dayparting.
 *
 * ⚠ `paidLane` is chosen from the SCORED lanes, not from all three. The claim is *"among the lanes
 * with enough traffic to judge, we are paying most into the wrong one"*. Widening it to
 * `max over all lanes` answers a different question — a lane with a big multiplier and 3 clicks is
 * not evidence of anything — and would not reconcile with the study's population.
 *
 * The zero-multiplier guard is separate from evaluability on purpose: a campaign with two
 * well-trafficked lanes and no multiplier anywhere is measurable (it counts in the denominator)
 * and is not inverted, because nothing is being paid into the wrong lane. It is a different
 * finding, and P3 is where "you are paying nothing into your best lane" gets its own name.
 */
export function inversionOf(lanes: PlcLaneScore[]): { evaluable: boolean; inversion: PlcInversion | null } {
  const scored = lanes.filter((l) => l.clicks >= INVERSION_MIN_CLICKS && l.roas != null)
  if (scored.length < 2) return { evaluable: false, inversion: null }
  // Evaluable from here on, whatever the verdict — the denominator must not depend on the answer.
  if (Math.max(...lanes.map((l) => l.multiplierPct)) === 0) return { evaluable: true, inversion: null }

  const paid = scored.reduce((a, b) => (b.multiplierPct > a.multiplierPct ? b : a))
  const best = scored.reduce((a, b) => ((b.roas ?? -1) > (a.roas ?? -1) ? b : a))
  /**
   * 🔴 …and the winner of `scored` must itself be paid something.
   *
   * The account-wide guard above misses the case where the multiplier sits on a lane with too
   * little traffic to score. Measured 2026-08-12: `IT-AIREON-SP-Category-Phrase` held
   * `product 0%/41 clicks · rest 0%/37 clicks · top 75%/2 clicks`, and the verdict read *"paying
   * most into Rest at 0%"* — a sentence that is simply false. It pays most into Top; Top just
   * cannot be judged.
   *
   * This is the same intent as the guard above ("nothing is being paid"), correctly scoped to the
   * judgeable set. It is NOT the widening the brief warns against — `paid` is still chosen from
   * `scored`, so the population is unchanged; only a verdict that asserted something untrue is
   * withdrawn. "You pay into a lane we cannot judge while a measurable lane returns 7.44×" is a
   * real and different finding, and it belongs to P3 with a name of its own.
   */
  if (paid.multiplierPct === 0) return { evaluable: true, inversion: null }
  if (paid.lane === best.lane || (best.roas ?? 0) <= (paid.roas ?? 0)) return { evaluable: true, inversion: null }

  return {
    evaluable: true,
    inversion: {
      paidLane: paid.lane, paidPct: paid.multiplierPct, paidRoas: paid.roas!,
      bestLane: best.lane, bestPct: best.multiplierPct, bestRoas: best.roas!,
    },
  }
}

/**
 * Up-and-down bidding compounding with a Top multiplier over 100%.
 *
 * **Measured: 0 campaigns**, of 11 on `AUTO_FOR_SALES`. Kept precisely because nothing violates it
 * — a guardrail added while it is free is the cheapest one this account will ever get.
 *
 * The arithmetic, which is what makes it believable: Amazon charges `base × (1 + top%)`, and
 * up-and-down lets Amazon add up to another +100% at top of search on top of that. The headroom
 * multiplier is `STRATEGY_HEADROOM`, **imported** from the controller rather than retyped as `2` —
 * if the engine's view of a strategy ever changes, this changes with it.
 */
export function compoundingOf(biddingStrategy: string | null | undefined, topPct: number): { at: boolean; worstCaseMultiple: number } {
  const headroom = strategyHeadroom(biddingStrategy)
  return {
    at: headroom > 1 && topPct > 100,
    // base × (1 + top%) × strategy headroom — the most Amazon can charge against the base bid.
    worstCaseMultiple: (1 + topPct / 100) * headroom,
  }
}

export interface PlcDecorative {
  targetKey: string
  /** the floor the engine pins to — `biasBand().floor` */
  heldPct: number
  targetISPct: number | null
  acosCapPct: number | null
}

/**
 * 🔴 A plan that names a goal the controller cannot read.
 *
 * `biasBand` (`rank-controller.ts:87`) is IMPORTED, never reimplemented — a second copy of that
 * three-line function is how this whole programme got the engine wrong for a day. With
 * `maxBiasPct` null and `allOut` false the ceiling collapses onto the floor, `canChase` is false,
 * and `computeStep` returns at `:201` **before it ever reads `targetISPct` or `acosCapPct`**. So a
 * schedule can display "hold 70% of top-of-search under a 45% ACoS cap" while the engine pins 150%
 * and stops.
 *
 * ⚠ **Evaluate every target the schedule CAN reach, never only what it holds now.** `lastApplied`
 * is hour-dependent: at 02:56 all 33 schedules hold `pause`, which carries no IS target and no
 * ACoS cap, so a flag read off `lastApplied` would report **0 decorative at night and 29 by day** —
 * the identical defect PLC.0 found in `carrying`, reintroduced one flag along.
 *
 * Reading the reachable set is reading data. Deciding which one governs *right now* is
 * `resolveActiveTargetKey`, the substrate owns it, and spec §8.7 bans a second copy — so "what it
 * holds now" keeps coming from the engine's own stamped `lastApplied`.
 *
 * Measured: all five `RankTarget` rows have `maxBiasPct = null`; the only ceilings anywhere are 9
 * per-scope overrides on 4 `GALE | IT` schedules. **Expect 29 of 33 decorative.**
 */
export interface PlcChaseable {
  targetKey: string
  floor: number
  ceiling: number
  /** all-out climbs to the ceiling but **ignores ACoS by design** (`rank-controller.ts:183`) */
  allOut: boolean
}

/** The targets that CAN move — the other half of the decorative story, and the one the study missed. */
export function chaseableOf(specs: RankTargetSpec[]): PlcChaseable[] {
  return specs
    .filter((sp) => sp.allOut || biasBand(sp).ceiling > biasBand(sp).floor)
    .map((sp) => ({ targetKey: sp.key, floor: biasBand(sp).floor, ceiling: biasBand(sp).ceiling, allOut: !!sp.allOut }))
}

export function decorativeOf(specs: RankTargetSpec[]): PlcDecorative[] {
  const out: PlcDecorative[] = []
  for (const spec of specs) {
    const band = biasBand(spec)
    const canChase = spec.allOut || band.ceiling > band.floor
    if (canChase) continue
    if (spec.targetISPct == null && spec.acosCapPct == null) continue
    out.push({
      targetKey: spec.key,
      heldPct: band.floor,
      targetISPct: spec.targetISPct,
      acosCapPct: spec.acosCapPct,
    })
  }
  return out
}

/**
 * A `RankTarget` row shaped into the controller's spec type.
 *
 * `toSpec` in `ad-rank-defend.job.ts:58` does exactly this and is **not exported**. This is a
 * field mapping and decides nothing — both functions that decide (`biasBand`, `applyTargetOverrides`)
 * are imported from where the engine keeps them, so there is no second opinion here to drift.
 */
export function specOfTarget(t: {
  key: string; placement: string; targetISPct: number | null; acosCapPct: number | null
  maxCpcCents: number | null; biasPct: number | null; pause: boolean; allOut: boolean
  maxBiasPct: number | null; keepClimbing: boolean | null; lanes: unknown
}): RankTargetSpec {
  return {
    key: t.key,
    placement: t.placement,
    targetISPct: t.targetISPct,
    acosCapPct: t.acosCapPct,
    maxCpcCents: t.maxCpcCents,
    biasPct: t.biasPct,
    pause: t.pause,
    allOut: t.allOut,
    maxBiasPct: t.maxBiasPct,
    keepClimbing: !!t.keepClimbing,
    lanes: Array.isArray(t.lanes) ? (t.lanes as RankTargetSpec['lanes']) : null,
  }
}

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
  /**
   * campaign id → the reachable targets whose stated goal the controller cannot read.
   *
   * Keyed by campaign rather than by schedule because that is the grain the grid renders, and
   * computed over every target the schedule CAN reach rather than the one it holds — see
   * `decorativeOf`.
   */
  decorativeByCampaign: Map<string, { decorative: PlcDecorative[]; chaseable: PlcChaseable[] }>
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
  /**
   * 🔴 PLC.1 — the POSTGRES clock, and the timezone windows actually resolve in.
   *
   * `ad-rank-defend.job.ts:32` sources "now" from `SELECT now()` rather than the container clock,
   * deliberately: Railway cron containers have run ~2h behind real time while Postgres stayed
   * correct, which silently shifted every window. A page that printed `new Date()` in the browser
   * would name a third clock — the operator's — and be wrong in a fourth way. This is the clock the
   * engine decided with.
   */
  nowUtc: string
  /** the same instant in `Europe/Rome`, e.g. "Wed 02:56" — the timezone the windows are painted in */
  nowLocal: string
  timezone: string
  /**
   * The goal library the live schedules can reach, so the sentence can say what they hold at OTHER
   * hours rather than only at this one. `heldPct` is `biasBand().floor` — what the engine pins to.
   */
  library: Array<{ targetKey: string; placement: string; heldPct: number; decorative: boolean }>
}

/**
 * 🔴 The poll cursor — and why it is NOT Bid's.
 *
 * `useCursorPoll`'s header states the one way to misuse it: copying a sibling's cursor shape
 * without re-measuring. Bid's load-bearing field is `max(AdTarget.updatedAt)`, because the hourly
 * keyword-bid resync moves a bid and writes no audit row. Neither half of that applies here.
 *
 *   · `AdTarget.updatedAt` is about keyword bids. A placement multiplier lives in
 *     `Campaign.dynamicBidding`, and no `AdTarget` moves when it changes.
 *   · `Campaign.updatedAt` is the obvious candidate and is the wrong one, for the reason BUD.1
 *     measured on its own subject: the column fires for every field on a wide row, so it would
 *     light the banner far more often wrongly than rightly.
 *
 * What actually records a placement change is `CampaignBidHistory` — **one row per changed lane**,
 * written by `updatePlacementBidding` (`ads-create.service.ts:905`) on the single path both the
 * engine and the manual `PATCH` go through. 11,652 rows in 60 days, 100% attributed since
 * 2026-08-03.
 *
 * `holding` is the third field and it is not decoration: this page prints what the engine is
 * holding, and the engine can switch every schedule from `pause` to `own-top` at an hour boundary
 * — changing the census and every governed campaign's multiplier — in writes that a `changedAt`
 * watcher sees only if a lane value actually moved. Tallying `lastApplied` catches the switch
 * itself. `lastEvaluatedAt` was rejected for the field: it re-stamps every 15 minutes whether or
 * not anything changed, which is precisely the "fires more often wrongly than rightly" failure.
 */
export interface PlcCursor {
  /** max(CampaignBidHistory.changedAt) over the three lane fields, in scope */
  placementAt: string | null
  /** how many such rows — a create/delete moves this when neither timestamp does */
  n: number
  /** the engine's held-target tally, e.g. "pause:33" — moves when the plan switches hours */
  holding: string
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
      lastApplied: true, lastEvaluatedAt: true, targetOverrides: true,
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

  /**
   * PLC.1 — the decorative-goal verdict, per campaign.
   *
   * Loaded here because this function already holds every schedule and its overrides. The five
   * `RankTarget` rows are the whole goal library; reading them costs one query.
   */
  const decorativeByCampaign: PlcOwnership['decorativeByCampaign'] = new Map()
  const targets = await prisma.rankTarget.findMany({
    select: {
      key: true, placement: true, targetISPct: true, acosCapPct: true, maxCpcCents: true,
      biasPct: true, pause: true, allOut: true, maxBiasPct: true, keepClimbing: true, lanes: true,
    },
  })
  const targetByKey = new Map(targets.map((t) => [t.key, specOfTarget(t)]))
  for (const s of goal) {
    // 🔴 Every target this schedule CAN reach, not the one it holds. `lastApplied` is hour-
    // dependent and at night every schedule holds `pause`, which names no goal at all — a flag
    // read off it would report 0 decorative overnight and 29 by day.
    const windows = Array.isArray(s.windows) ? (s.windows as Array<{ targetKey?: string }>) : []
    const reachable = [...new Set([s.defaultTargetKey, ...windows.map((w) => w?.targetKey)].filter((k): k is string => !!k))]
    const specs = reachable
      .map((k) => targetByKey.get(k))
      .filter((sp): sp is RankTargetSpec => !!sp)
      // The per-scope override merge, in the engine's own function. 9 of the 20 override entries
      // raise a ceiling — those are precisely the schedules that are NOT decorative, and skipping
      // this merge would flag all 33.
      .map((sp) => applyTargetOverrides(sp, s.targetOverrides as Parameters<typeof applyTargetOverrides>[1]))
    const dec = decorativeOf(specs)
    const chase = chaseableOf(specs)
    if (dec.length > 0 || chase.length > 0) decorativeByCampaign.set(s.campaignId, { decorative: dec, chaseable: chase })
  }

  // The receipt, tallied from what the engine stamped. `governedAtZero` is filled by the caller,
  // which is the only place that has already read the campaigns' current lanes.
  const held = new Map<string, number>()
  for (const s of goal) held.set(String(s.lastApplied ?? 'nothing due'), (held.get(String(s.lastApplied ?? 'nothing due')) ?? 0) + 1)
  const newest = goal.map((s) => s.lastEvaluatedAt).filter((d): d is Date => !!d).sort((a, b) => +b - +a)[0]

  // The clock the ENGINE decides with — `SELECT now()`, exactly as `ad-rank-defend.job.ts:32`
  // sources it, and for the reason its own comment gives (Railway container clock skew).
  const clockRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() as now`
  const nowUtc = clockRows?.[0]?.now instanceof Date ? clockRows[0]!.now : new Date(clockRows?.[0]?.now as unknown as string)
  const nowLocal = new Intl.DateTimeFormat('en-GB', {
    timeZone: RANK_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(nowUtc)

  // The library the live schedules can reach — what they hold at OTHER hours, deduped.
  const reachableKeys = new Set<string>()
  for (const s of goal) {
    const w = Array.isArray(s.windows) ? (s.windows as Array<{ targetKey?: string }>) : []
    for (const k of [s.defaultTargetKey, ...w.map((x) => x?.targetKey)]) if (k) reachableKeys.add(k)
  }
  const library = [...reachableKeys]
    .map((k) => targetByKey.get(k))
    .filter((sp): sp is RankTargetSpec => !!sp)
    .map((sp) => ({
      targetKey: sp.key,
      placement: sp.placement,
      heldPct: biasBand(sp).floor,
      decorative: decorativeOf([sp]).length > 0,
    }))
    .sort((a, b) => b.heldPct - a.heldPct || a.targetKey.localeCompare(b.targetKey))

  return {
    byCampaign,
    decorativeByCampaign,
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
      nowUtc: nowUtc.toISOString(),
      nowLocal,
      timezone: RANK_TZ,
      library,
    },
  }
}

/**
 * The poll cursor. Three cheap aggregates, ~100 bytes, meant to be hit every 45 s by every open
 * tab. The grid read is not. Separate endpoint rather than a `?cursorOnly=1` on the grid so it
 * cannot quietly acquire the expensive parts of that handler later — BID.S0's reasoning, adopted.
 *
 * See `PlcCursor` for why these three fields and not Bid's.
 */
export async function getPlacementCursor(campaignIds: string[] | null, noCampaigns = false): Promise<PlcCursor> {
  if (noCampaigns) return { placementAt: null, n: 0, holding: '' }
  const where = {
    field: { in: [...PLC_LANES] },
    ...(campaignIds ? { campaignId: { in: campaignIds } } : {}),
  }
  const [newest, n, schedules] = await Promise.all([
    prisma.campaignBidHistory.findFirst({ where, orderBy: { changedAt: 'desc' }, select: { changedAt: true } }),
    prisma.campaignBidHistory.count({ where }),
    // Account-wide rather than scoped: `AdSchedule` has no market column and the engine switches
    // every schedule at the same hour boundary anyway, so scoping it would cost a join to say the
    // same thing. It can only ever fire slightly too often, which costs one refetch.
    prisma.adSchedule.findMany({ where: { enabled: true }, select: { windows: true, defaultTargetKey: true, lastApplied: true } }),
  ])
  const tally = new Map<string, number>()
  for (const s of schedules) {
    if (!isGoalMode(s.windows, s.defaultTargetKey)) continue
    const k = String(s.lastApplied ?? 'nothing due')
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  return {
    placementAt: newest?.changedAt?.toISOString() ?? null,
    n,
    holding: [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join(','),
  }
}

/** The cursor for a request's scope, resolved the same way the grid resolves it. */
export async function getPlacementCursorForRequest(
  req: Pick<PlcRequest, 'market' | 'line' | 'portfolio' | 'campaign'>,
): Promise<PlcCursor> {
  const scope = await resolveScope({ ...req } as PlcRequest)
  return getPlacementCursor(scope.campaignIds, scope.campaignIds != null && scope.campaignIds.length === 0)
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

  /**
   * 🔴 The search narrows the ROWS. It must never narrow the COUNTS.
   *
   * Caught by typing into the box on production, not by reading this file: with `?q=` matching
   * nothing, `counts` were computed over the searched set, so the page read
   * *"0 campaigns · 0 carrying a multiplier · 0 governed by nothing"* over a 220-campaign scope
   * and offered "widen the scope" when the thing to clear was the search. A count that moves when
   * you type is answering a different question from the one its label asks — the exact defect this
   * page exists to remove, reproduced inside it.
   *
   * So: every count below is over `campaigns` (the resolved scope). Only `rows` and
   * `matchedCampaigns` see the needle.
   *
   * The filter is applied to the CAMPAIGN before the lanes are expanded, so a search always returns
   * whole campaigns — three rows — rather than an arbitrary subset of one campaign's lanes.
   */
  const needle = (req.q ?? '').trim().toLowerCase()
  const matched = needle ? campaigns.filter((c) => c.name.toLowerCase().includes(needle)) : campaigns

  // The report reads cover the whole SCOPE, not the search: `withReportRow` and `dataThrough` are
  // statements about the scope's feed, and they must not move when you type either.
  const extIds = [...new Set(campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x))]

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

  /**
   * PLC.1 — the flags, computed per CAMPAIGN over the whole SCOPE.
   *
   * Over the scope and not over `matched`, for the same reason every count is: `?q=` narrows what
   * you are looking at, never what is true. The census reads from here; the rows read the same map.
   */
  const laneMetricsOf = (c: (typeof campaigns)[number], lane: PlcLane) =>
    (c.externalCampaignId ? metrics.get(`${c.externalCampaignId}|${lane}`) : undefined)

  const flagsByCampaign = new Map<string, PlcRowFlags>()
  for (const c of campaigns) {
    const mult = laneMultipliers(c.dynamicBidding)
    const scores: PlcLaneScore[] = PLC_LANES.map((lane) => {
      const m = laneMetricsOf(c, lane)
      const spend = m?.spendCents ?? 0
      return {
        lane,
        multiplierPct: mult[lane],
        clicks: m?.clicks ?? 0,
        roas: spend > 0 ? (m?.salesCents ?? 0) / spend : null,
      }
    })
    const { evaluable, inversion } = inversionOf(scores)
    const comp = compoundingOf(c.biddingStrategy, mult[PLACEMENT_TOP])
    flagsByCampaign.set(c.id, {
      invertedEvaluable: evaluable,
      inversion: inversion
        ? { ...inversion, paidLaneKey: KEY_BY_LANE[inversion.paidLane], bestLaneKey: KEY_BY_LANE[inversion.bestLane] }
        : null,
      compounding: comp.at,
      compoundingMultiple: comp.worstCaseMultiple,
      // Campaign-level: carries a multiplier SOMEWHERE and no engine governs it. The per-lane chip
      // in the client is narrower on purpose — it points at the lane that carries the number.
      unmanaged: !ownership.byCampaign.has(c.id) && PLC_LANES.some((l) => mult[l] > 0),
      decorative: ownership.decorativeByCampaign.get(c.id)?.decorative ?? [],
      chaseable: ownership.decorativeByCampaign.get(c.id)?.chaseable ?? [],
    })
  }

  // ── expand: one row per campaign per lane, always three ────────────────────────────────────
  const rows: PlcRow[] = []
  for (const c of matched) {
    const mult = laneMultipliers(c.dynamicBidding)
    const own = ownership.byCampaign.get(c.id)
    const isPoints = c.externalCampaignId ? isByCampaign.get(c.externalCampaignId) : undefined
    const flags = flagsByCampaign.get(c.id)!
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
        flags,
      })
    }
  }

  // ── counts, over the resolved scope and BEFORE the lane filter ─────────────────────────────
  // The lane filter narrows what you are looking at; it does not change how many campaigns carry
  // a multiplier. A count that moved when you clicked "Top" would be answering a different
  // question from the one its label asks.
  const carrying = campaigns.filter((c) => {
    const m = laneMultipliers(c.dynamicBidding)
    return PLC_LANES.some((l) => m[l] > 0)
  })
  const withReport = new Set(
    campaigns.filter((c) => c.externalCampaignId && PLC_LANES.some((l) => metrics.has(`${c.externalCampaignId}|${l}`))).map((c) => c.id),
  )
  const governedInScope = campaigns.filter((c) => ownership.byCampaign.has(c.id))
  const counts = {
    campaigns: campaigns.length,
    /** how many of them the search left — the ONLY count the needle touches */
    matchedCampaigns: matched.length,
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

  /**
   * 🔴 PLC.1 — every flag ships with the population it was computed over.
   *
   * `inverted` needs traffic to be computable: the study's 8 came from **18 evaluable campaigns of
   * 220 over 60 days**. Over a 7-day window almost nothing clears 20 clicks on two lanes, and a
   * bare "0 inverted" there would be *"we could not check"* wearing the words of *"we checked"* —
   * the exact defect class this page exists to remove. So `of` is never optional, and the client is
   * required to print it and to say "not enough traffic to judge" when `of` is 0.
   */
  const flagList = campaigns.map((c) => flagsByCampaign.get(c.id)!)
  const upAndDown = campaigns.filter((c) => strategyHeadroom(c.biddingStrategy) > 1)
  const unmanagedCampaigns = campaigns.filter((c) => flagsByCampaign.get(c.id)!.unmanaged)
  const flags = {
    inverted: {
      n: flagList.filter((f) => f.inversion != null).length,
      /** campaigns with ≥20 clicks on ≥2 lanes in THIS window — the honest denominator */
      of: flagList.filter((f) => f.invertedEvaluable).length,
      minClicks: INVERSION_MIN_CLICKS,
      /** of the inverted, how many an engine is actively maintaining — a different fix, elsewhere */
      engineMaintained: campaigns.filter((c) => flagsByCampaign.get(c.id)!.inversion != null && ownership.byCampaign.has(c.id)).length,
    },
    compounding: {
      n: flagList.filter((f) => f.compounding).length,
      /** campaigns whose bidding strategy has headroom above 1× — only these can compound */
      of: upAndDown.length,
    },
    unmanaged: {
      n: unmanagedCampaigns.length,
      /** carrying a multiplier at all — the only population "governed by nothing" can be a share of */
      of: carrying.length,
      // A multiplier on a PAUSED campaign spends nothing and is not a mistake to fix. The status
      // tooltip on the grid already says this; the census must agree with it rather than imply
      // 144 things need doing.
      live: unmanagedCampaigns.filter((c) => c.status === 'ENABLED').length,
      paused: unmanagedCampaigns.filter((c) => c.status === 'PAUSED').length,
      archived: unmanagedCampaigns.filter((c) => c.status === 'ARCHIVED').length,
    },
    /**
     * 🔴 Every governed campaign is decorative, and the useful number is the breakdown.
     *
     * The study's flag table put this at "29 of 33", counting the schedules with no per-scope
     * ceiling override. Re-measured 2026-08-12, that reading misses `own-top-allout`: it carries
     * `allOut: true`, so `biasBand` gives it ceiling **900** against floor 300 WITHOUT any
     * override, and 22 of the 33 schedules can reach it. Study §1.1's own goal table says so
     * ("chases? YES → 900"); the flag table did not carry it through.
     *
     * So the honest count is 33 of 33 — every live schedule can reach at least one of `own-top`,
     * `defend-top` or `rest-of-search`, all of which name an IS target and an ACoS cap the
     * controller returns before reading. A flag true of the whole population is a weak filter and
     * a strong finding, so the breakdown carries the part an operator can act on:
     *
     *   · `withRealCeiling` — a per-scope override raises a ceiling on a target that reads a goal.
     *     **4 schedules**, all `GALE | IT` (`own-top` floor 100 → ceiling 200). These are the
     *     study's "4 exceptions".
     *   · `allOutOnly` — can chase only via `own-top-allout`, which climbs but **ignores ACoS by
     *     design**, so its ACoS cap is decoration too.
     *   · `noneCanChase` — nothing it can reach moves at all.
     */
    decorative: {
      n: flagList.filter((f) => f.decorative.length > 0).length,
      /** campaigns an engine governs — hour-independent, unlike `counts.governed` */
      of: governedInScope.length,
      withRealCeiling: flagList.filter((f) => f.chaseable.some((ch) => !ch.allOut)).length,
      allOutOnly: flagList.filter((f) => f.chaseable.length > 0 && f.chaseable.every((ch) => ch.allOut)).length,
      noneCanChase: flagList.filter((f) => f.decorative.length > 0 && f.chaseable.length === 0).length,
    },
  }

  /**
   * The scope's lane split — the clearest single statement of the inversion at scope level.
   *
   * Account-wide over 60 days: Top **2.3% of impressions / 45.2% of spend / 1.80×** · Rest 21.9% /
   * 35.6% / 3.11× · Product 75.8% / 19.2% / 2.39×. Recomputed from the same `metrics` map the rows
   * read, never printed as a constant — those three numbers are an argument, and an argument that
   * stops tracking its evidence is a slogan.
   */
  const laneTotals = PLC_LANES.map((lane) => {
    let impressions = 0, clicks = 0, spendCents = 0, salesCents = 0, orders = 0
    for (const c of campaigns) {
      const m = laneMetricsOf(c, lane)
      if (!m) continue
      impressions += m.impressions; clicks += m.clicks
      spendCents += m.spendCents; salesCents += m.salesCents; orders += m.orders
    }
    return { laneKey: KEY_BY_LANE[lane], lane, impressions, clicks, spendCents, salesCents, orders }
  })
  const totalImpressions = laneTotals.reduce((a, l) => a + l.impressions, 0)
  const totalSpend = laneTotals.reduce((a, l) => a + l.spendCents, 0)
  const lanes = laneTotals.map((l) => ({
    ...l,
    impressionsPct: totalImpressions > 0 ? l.impressions / totalImpressions : null,
    spendPct: totalSpend > 0 ? l.spendCents / totalSpend : null,
    roas: l.spendCents > 0 ? l.salesCents / l.spendCents : null,
    cpc: l.clicks > 0 ? l.spendCents / l.clicks : null,
    cvr: l.clicks > 0 ? l.orders / l.clicks : null,
  }))

  // ── filter + sort ──────────────────────────────────────────────────────────────────────────
  // `?flag=` filters CAMPAIGNS and keeps all their lanes, because a lane you cannot see beside the
  // others is not evidence — an inversion is a statement about lanes relative to each other. Like
  // `?q=` and `?lane=`, it narrows rows and never a count.
  const flagFiltered = req.flag === 'all' ? rows : rows.filter((r) => {
    const f = r.flags
    return req.flag === 'inverted' ? f.inversion != null
      : req.flag === 'compounding' ? f.compounding
        : req.flag === 'unmanaged' ? f.unmanaged
          : req.flag === 'decorative' ? f.decorative.length > 0
            : true
  })
  const laneFiltered = req.lane === 'all' ? flagFiltered : flagFiltered.filter((r) => r.laneKey === req.lane)
  const key: PlcSortKey = req.sort ?? 'spend'
  const sign = req.dir === 'asc' ? 1 : -1
  const sorted = [...laneFiltered].sort((a, b) => {
    const primary = cmp(sortValue(a, key), sortValue(b, key), sign)
    if (primary !== 0) return primary
    // A stable, meaningful tie-break: a campaign's three lanes stay in Top → Rest → Product order
    // inside an equal-valued block, so 113 campaigns with no delivery do not shuffle on reload.
    return a.name.localeCompare(b.name) || PLC_LANES.indexOf(a.lane) - PLC_LANES.indexOf(b.lane)
  })

  // The cursor this payload was read with, so `useCursorPoll` has a baseline that describes exactly
  // these rows rather than one fetched a moment later.
  const cursor = await getPlacementCursor(scope.campaignIds, noCampaigns)

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
    flags,
    lanes,
    cursor,
    lane: req.lane,
    flag: req.flag,
    rows: sorted,
    total: sorted.length,
  }
}
