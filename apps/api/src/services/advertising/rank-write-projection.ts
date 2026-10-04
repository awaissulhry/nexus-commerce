/**
 * 2c (review G.11) — about how many changes a day an hourly bid plan sends to Amazon, read off its painted hour table.
 *
 * Since 2e the rank loop holds each hour's FIXED values and writes only when the hour's value differs from what is live,
 * so its volume is decided by the painting, not by the 15-minute tick: every switch into or out of Min bid moves every
 * bid in the campaign (ad-group default bids and target bids), every placement change is one change, and a base-bid
 * directive moves the bids it names. The review measured ~1,322 rank writes a day: ~766 the night floor and the morning
 * give-back, ~556 placement changes at hour boundaries.
 *
 * Pure (no database, no clock), so the list and the builder quote the same numbers the tests pin. It walks the week
 * hour by hour with the same rules as ad-rank-defend.job.ts, twice round, and counts the second lap — the steady state,
 * where Monday 00:00 follows Sunday 23:00. It is an estimate on purpose and says so on screen ("about"): it assumes
 * every bid sits above the floor (a bid already at or under it does not move), ignores the CPC ceiling (which can only
 * hold a placement lower) and an out-of-budget hold, and counts the Min-bid limit (at most 2 entries a day, the job's
 * anti-flap) by the plan's own day where the job counts by UTC day.
 */
import { resolveActiveTargetKey, type RankTargetSpec, type ScheduleWindow } from './rank-controller.js'
import { buildBlendedAdjustments, clampPct, PLACEMENT_REST, PLACEMENT_TOP } from './ads-placement-math.js'

/** 2c — the job's anti-flap: a campaign enters Min bid at most this many times a day; after that it keeps serving. */
export const MAX_MIN_BID_ENTRIES_PER_DAY = 2

/** What a campaign holds under the plan: the bid entities a floor or a give-back moves. */
export interface ProjectionCampaign { adGroups: number; targets: number }

/**
 * Changes by kind, in the job's order: `restore` = bids given back (a floor lifted, a base-bid change reverted),
 * `suppress` = bids floored (Min bid, a re-floor, base bid = floor), `placement` = placement changes (one per campaign
 * write), `base` = base-bid changes. The rank tick's summary line counts its own writes with the same four.
 */
export interface RankWriteCounts { restore: number; suppress: number; placement: number; base: number }
export const noWrites = (): RankWriteCounts => ({ restore: 0, suppress: 0, placement: 0, base: 0 })

export interface RankWriteProjection {
  /** About how many changes a day (the week's total ÷ 7, rounded). */
  perDay: number
  perWeek: number
  /** The week's changes by kind. */
  byKind: RankWriteCounts
  /** Min-bid hours the anti-flap keeps serving in a week (a third or later entry on one day). */
  keptServing: number
}

interface State { floored: boolean; floorCents: number; place: Record<string, number>; delta: number | null; absCents: number | null }

// The same rule as normaliseFloorCents (ads-bid-suppression.service.ts), which this module cannot import because that
// service reads the database: blank → the legacy 2¢, otherwise clamped to 2¢..€100.
const floorOf = (cents: number | null | undefined): number =>
  cents == null || !Number.isFinite(cents) ? 2 : Math.max(2, Math.min(10_000, Math.round(cents)))

const otherSearch = (p: string): string | null => (p === PLACEMENT_TOP ? PLACEMENT_REST : p === PLACEMENT_REST ? PLACEMENT_TOP : null)

/** setSearchPlacement's shape: the placement takes its %, and Top and Rest of search exclude each other. */
function searchPlaced(place: Record<string, number>, placement: string, pct: number): Record<string, number> {
  const out = { ...place, [placement]: pct }
  const other = otherSearch(placement)
  if (other) out[other] = 0
  return out
}

const samePlace = (a: Record<string, number>, b: Record<string, number>): boolean => {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false
  return true
}

/** One hour of the job, for one campaign: what it writes and what it leaves live. `spec` null = nothing is held. */
function hour(s: State, spec: RankTargetSpec | null, c: ProjectionCampaign, entriesToday: number, n: RankWriteCounts): { s: State; entered: boolean; kept: boolean } {
  const bids = Math.max(0, c.adGroups) + Math.max(0, c.targets)
  // Nothing held (no window, no baseline, or a deleted target): the job gives back its floor and its base-bid change.
  if (!spec) {
    const next = { ...s }
    if (s.floored) { n.restore += bids; next.floored = false }
    if (s.delta != null) { n.restore += bids; next.delta = null }
    return { s: next, entered: false, kept: false }
  }
  if (spec.pause) {
    const floor = floorOf(spec.floorBidCents)
    // Anti-flap: a third entry on one day is not made; the campaign keeps serving and nothing is written this hour.
    if (!s.floored && entriesToday >= MAX_MIN_BID_ENTRIES_PER_DAY) return { s, entered: false, kept: true }
    const next = { ...s }
    let entered = false
    if (!s.floored) { n.suppress += bids; next.floored = true; next.floorCents = floor; entered = true }
    else if (s.floorCents !== floor) { n.suppress += bids; next.floorCents = floor }
    if (spec.biasPct != null) {
      const want = clampPct(spec.biasPct)
      if ((s.place[spec.placement] ?? 0) !== want) { n.placement += 1; next.place = searchPlaced(s.place, spec.placement, want) }
    }
    return { s: next, entered, kept: false }
  }
  // A serving hour, in the job's order: give the floor back, then the base-bid change, then placement, then base bid.
  const next = { ...s }
  let entered = false
  if (s.floored && spec.bidMode !== 'suppress') { n.restore += bids; next.floored = false }
  if (spec.bidMode !== 'deltaPct' && s.delta != null) { n.restore += bids; next.delta = null }
  if (spec.lanes && spec.lanes.length) {
    const adjusted = buildBlendedAdjustments(
      Object.entries(s.place).map(([placement, percentage]) => ({ placement, percentage })),
      spec.lanes.map((l) => ({ placement: l.placement, percentage: clampPct(l.biasPct ?? 0) })),
    )
    const place = { ...s.place }
    for (const a of adjusted) place[a.placement] = a.percentage
    if (!samePlace(s.place, place)) { n.placement += 1; next.place = place }
  } else {
    const want = clampPct(spec.biasPct ?? 0)
    const other = otherSearch(spec.placement)
    if ((s.place[spec.placement] ?? 0) !== want || (other != null && (s.place[other] ?? 0) > 0)) {
      n.placement += 1
      next.place = searchPlaced(s.place, spec.placement, want)
    }
  }
  if (spec.bidMode === 'suppress' && !next.floored) {
    if (entriesToday >= MAX_MIN_BID_ENTRIES_PER_DAY) return { s: next, entered: false, kept: true }
    n.suppress += bids; next.floored = true; next.floorCents = 2; entered = true
  } else if (spec.bidMode === 'absolute' && spec.bidValueCents != null && spec.bidValueCents > 0) {
    if (s.absCents !== spec.bidValueCents) { n.base += Math.max(0, c.adGroups); next.absCents = spec.bidValueCents }
  } else if (spec.bidMode === 'deltaPct' && spec.bidDeltaPct != null) {
    if (s.delta !== spec.bidDeltaPct) { n.base += bids; next.delta = spec.bidDeltaPct }
  }
  return { s: next, entered, kept: false }
}

/**
 * About how many changes a week (and a day) one campaign's plan sends to Amazon. `specFor` is the target a key names
 * for this campaign, overrides applied (null = no such target); the hour table resolves exactly as the job resolves it.
 */
export function projectRankWrites(input: {
  windows: ScheduleWindow[] | null | undefined
  defaultTargetKey: string | null | undefined
  specFor: (key: string) => RankTargetSpec | null
  campaign: ProjectionCampaign
}): RankWriteProjection {
  const specs = new Map<string, RankTargetSpec | null>()
  const specOf = (key: string | null): RankTargetSpec | null => {
    if (!key) return null
    if (!specs.has(key)) specs.set(key, input.specFor(key))
    return specs.get(key) ?? null
  }
  let s: State = { floored: false, floorCents: 2, place: {}, delta: null, absCents: null }
  const counted: RankWriteCounts = noWrites()
  let keptServing = 0
  for (let lap = 0; lap < 2; lap++) {
    const n: RankWriteCounts = lap === 1 ? counted : noWrites()
    for (let day = 0; day < 7; day++) {
      let entries = 0
      for (let h = 0; h < 24; h++) {
        const r = hour(s, specOf(resolveActiveTargetKey(input.windows, input.defaultTargetKey, day, h)), input.campaign, entries, n)
        s = r.s
        if (r.entered) entries++
        if (r.kept && lap === 1) keptServing++
      }
    }
  }
  const perWeek = counted.restore + counted.suppress + counted.placement + counted.base
  return { perDay: Math.round(perWeek / 7), perWeek, byKind: counted, keptServing }
}

/** Add one campaign's projection into a plan's total (a plan binds many campaigns). */
export function addProjection(into: RankWriteProjection, p: RankWriteProjection): RankWriteProjection {
  into.perWeek += p.perWeek
  into.byKind.restore += p.byKind.restore; into.byKind.suppress += p.byKind.suppress
  into.byKind.placement += p.byKind.placement; into.byKind.base += p.byKind.base
  into.keptServing += p.keptServing
  into.perDay = Math.round(into.perWeek / 7)
  return into
}

export const emptyProjection = (): RankWriteProjection => ({ perDay: 0, perWeek: 0, byKind: noWrites(), keptServing: 0 })
