/**
 * RS.4 — pure rank controller: from the target the hour's plan names to the placement % a tick sets.
 * No DB / IO, so it's unit-tested and reused verbatim by the defend loop (ad-rank-defend.job.ts).
 *
 * 2e (Owner D1 = A, 2026-10-04) — an hour-of-day bid plan, not a rank chase. No Amazon signal can feed a 15-minute
 * loop (Top-of-search share is daily and 1–3 days late, SQP weekly, no organic-rank API), so each tick sets the
 * hour's FIXED Placement % and nothing else: no impression-share or ACoS reading, no climb/ease step, no keep-
 * climbing, no all-out climb, no ceiling chase. The goal fields stay in the database but are not read.
 */

// 2e — the fields marked "not read" are kept (the database still holds them) but no tick reads them since 2e.
export interface RankTargetSpec {
  key: string
  placement: string // PLACEMENT_TOP | PLACEMENT_REST_OF_SEARCH | PLACEMENT_PRODUCT_PAGE
  targetISPct: number | null // not read (2e)
  acosCapPct: number | null // not read (2e)
  maxCpcCents: number | null // hard bid ceiling (runaway guard): caps the placement % (MB.4)
  biasPct: number | null // the Placement % this target holds (blank = 0%)
  pause: boolean
  // MB.1 — for a `pause` (Min bid) target: the bid floor in cents it holds during its
  // hours. null = the engine's legacy 2¢. Read by the job's pause branch, not by
  // computeStep — a Min-bid hour never reaches the placement controller.
  floorBidCents?: number | null
  allOut: boolean // not read (2e): an all-out target holds its Placement % like any other
  // MP v2 motion profile — not read (2e): a tick snaps to the hour's Placement % in one write.
  jumpStartPct?: number | null
  stepUpPct?: number | null
  stepDownPct?: number | null
  maxBiasPct?: number | null
  keepClimbing?: boolean
  // BL — blended multi-placement + base-bid (all optional; absent => single-placement legacy).
  lanes?: LaneSpec[] | null // when set, the engine drives EACH lane's placement at once
  bidMode?: string | null // base-bid lever: null|'hold'|'absolute'|'suppress'|'deltaPct'
  bidValueCents?: number | null // 'absolute' → set ad-group default bid to this
  bidDeltaPct?: number | null // reserved for 'deltaPct'
}

// BL — one placement lane in a blended target. 2e — a lane holds its own Placement % (biasPct); its other fields are
// kept in the database and not read.
export interface LaneSpec {
  placement: string // PLACEMENT_TOP | PLACEMENT_REST_OF_SEARCH | PLACEMENT_PRODUCT_PAGE
  biasPct: number | null
  maxBiasPct?: number | null
  targetISPct?: number | null
  acosCapPct?: number | null
  stepUpPct?: number | null
  stepDownPct?: number | null
  keepClimbing?: boolean
  allOut?: boolean
}

export interface ScheduleWindow { days?: number[]; startHour?: number; endHour?: number; bidMultiplierPct?: number; targetKey?: string }

/**
 * Which WINDOW governs (day, hour) — the first one covering the moment that names a target.
 * `endHour` is EXCLUSIVE, which is the contract the authoring side (selectionToWindows) collapses
 * painted cells to. Split out of resolveActiveTargetKey so the E1 preview can say whether an hour
 * came from a window or from the baseline WITHOUT re-implementing this rule; a second copy of it
 * would be free to drift from the engine, which is exactly what a preview must never do.
 */
export function resolveActiveWindow(windows: ScheduleWindow[] | null | undefined, day: number, hour: number): ScheduleWindow | null {
  for (const w of windows ?? []) {
    if (!w?.targetKey) continue
    const days = w.days && w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6]
    const start = w.startHour ?? 0
    const end = w.endHour ?? 24
    if (days.includes(day) && hour >= start && hour < end) return w
  }
  return null
}

/**
 * Which target governs (day, hour): a window covering the moment with a targetKey
 * wins; otherwise the schedule baseline ("for the rest, hold Y"). null => no
 * goal-mode target here (legacy multiplier-only schedule).
 */
export function resolveActiveTargetKey(windows: ScheduleWindow[] | null | undefined, defaultTargetKey: string | null | undefined, day: number, hour: number): string | null {
  return resolveActiveWindow(windows, day, hour)?.targetKey ?? defaultTargetKey ?? null
}

/**
 * The [floor, ceiling] placement-bias band a target may occupy — the same numbers computeStep
 * uses, exported so the previews quote the engine rather than paraphrasing it. floor = the
 * Placement % the hour holds. 2e — nothing climbs above it any more (no ceiling chase, no all-out),
 * so the ceiling IS the floor; the CPC ceiling (cpcCapPct) is the only thing that can hold it lower.
 */
export function biasBand(target: Pick<RankTargetSpec, 'biasPct'>): { floor: number; ceiling: number } {
  const floor = clamp(target.biasPct ?? 0, 0, 900)
  return { floor, ceiling: floor }
}

/**
 * MB.4 — the CPC ceiling, finally enforced.
 *
 * `maxCpcCents` has been stored, per-scope overridable, labelled "never bid above this" and
 * printed in the arm preview since RS.1 — and read by nothing. computeStep never referenced
 * it; the bid path enforces a 5¢ floor and a max-change-% clamp and no ceiling at all. An
 * operator who set €2.00 on an all-out target got no ceiling whatsoever.
 *
 * It is enforced by capping the PLACEMENT multiplier rather than rewriting keyword bids,
 * because the multiplier is the lever this loop already owns: capping it is instant,
 * reversible, and cannot collide with the suppress/restore or base-bid-delta memories.
 *
 * Amazon charges base bid × (1 + placement %), and an `AUTO_FOR_SALES` campaign ("up and
 * down") lets Amazon add up to another +100% at Top of Search on top of that — so a ceiling
 * that ignored the bidding strategy would be breached by design on exactly the campaigns
 * most likely to have one set. `strategyMultiple` carries that headroom.
 *
 * `maxBaseBidCents` must be the campaign's HIGHEST live base bid: a ceiling derived from the
 * average would still let the most expensive keyword sail past it, which is the one thing
 * "never bid above this" cannot mean.
 *
 * Returns null when nothing can be capped — no ceiling set, or no base bid known (a campaign
 * with no bids cannot breach a ceiling). `baseAlone` reports the case the operator most needs
 * to see: the base bid ALONE already exceeds the ceiling, so even a 0% placement breaches it
 * and no multiplier cap can rescue it.
 */
export const STRATEGY_HEADROOM: Record<string, number> = {
  AUTO_FOR_SALES: 2, // up-and-down — Amazon may add up to +100% again at Top of Search
  LEGACY_FOR_SALES: 1, // down only
  MANUAL: 1, // fixed
}
export function strategyHeadroom(biddingStrategy: string | null | undefined): number {
  return (biddingStrategy && STRATEGY_HEADROOM[biddingStrategy]) || 1
}

/**
 * BID BRAIN BB-18 — the same headroom per placement: Amazon's "dynamic bids — up and down" adds up to +100 % at Top of
 * Search (strategyHeadroom) and up to +50 % on every other placement. The bid brain holds each lane's ceiling with it.
 */
export function laneHeadroom(biddingStrategy: string | null | undefined, placement: string): number {
  if (biddingStrategy === 'AUTO_FOR_SALES' && placement !== 'PLACEMENT_TOP') return 1.5
  return strategyHeadroom(biddingStrategy)
}

export interface CpcCap { capPct: number; baseAlone: boolean }
export function cpcCapPct(maxCpcCents: number | null | undefined, maxBaseBidCents: number | null | undefined, strategyMultiple = 1): CpcCap | null {
  if (maxCpcCents == null || !(maxCpcCents > 0)) return null
  if (maxBaseBidCents == null || !(maxBaseBidCents > 0)) return null
  const mult = strategyMultiple > 0 ? strategyMultiple : 1
  const raw = 100 * (maxCpcCents / (maxBaseBidCents * mult) - 1)
  // FLOOR, never round: rounding 344.9 up to 345 would land a bid over the ceiling, which is
  // the single thing this function exists to prevent.
  return raw < 0 ? { capPct: 0, baseAlone: true } : { capPct: Math.floor(raw), baseAlone: false }
}

// 2e — the placement % the target holds right now is all a tick needs: no impression share, ACoS or loss proxy.
export interface Observed {
  currentPct: number // the placement % live on the campaign for the target's placement (0-900)
}

export interface StepDecision { action: 'raise' | 'hold' | 'lower' | 'pause'; nextPct: number; reason: string }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)))

/**
 * The controller. 2e — set the hour's fixed Placement % (biasPct, blank = 0%) in one move, up or down, and hold it
 * there; `maxPct` (the CPC ceiling, when the caller passes it) can only hold it lower. Nothing else is read, so the
 * answer changes only when the hour's plan (or the live value) changes — and a tick writes only then.
 */
export function computeStep(target: RankTargetSpec, obs: Observed, opts: { maxPct?: number } = {}): StepDecision {
  if (target.pause) return { action: 'pause', nextPct: obs.currentPct, reason: 'target = Min bid' }
  const want = Math.min(biasBand(target).floor, clamp(opts.maxPct ?? 900, 0, 900))
  const cur = obs.currentPct
  if (cur < want) return { action: 'raise', nextPct: want, reason: `set to ${want}% Placement (this hour's plan)` }
  if (cur > want) return { action: 'lower', nextPct: want, reason: `set to ${want}% Placement (this hour's plan)` }
  return { action: 'hold', nextPct: cur, reason: `holding ${want}% Placement (this hour's plan)` }
}
