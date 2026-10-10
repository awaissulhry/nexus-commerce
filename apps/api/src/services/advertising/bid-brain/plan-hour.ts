/**
 * BID BRAIN BB-7 — an hourly bid plan's hour as the brain's input, for the campaigns it owns (live.ts). Rank-defend leaves
 * such a campaign (BB-6); the brain carries its plan's hour out, inside its own limits. Pure: plans.ts loads the hour.
 *
 *   which hour  the campaign's goal-mode schedule (AdSchedule: an Hourly Bids plan materialises one per member campaign,
 *               with that campaign's overrides; an active dated event of its group replaces the week), resolved with
 *               rank-defend's own rules — never a copy: resolveActiveTargetKey on nowInTz in the schedule's time zone,
 *               the target's spec (toSpec) with the campaign's overrides (applyTargetOverrides), the event picker
 *               (pickActiveEvents). Two goal-mode schedules on one campaign: the first by id (rank-defend runs both).
 *   Min bid     a `pause` (or base bid `suppress`) target: every keyword at its floor (floorBidCents, else 2¢) — MIN-BID
 *               HOUR — at most MAX_MIN_BID_ENTRIES_PER_DAY entries a UTC day, counted with rank-defend's (its anti-flap);
 *               a later Min-bid hour keeps the campaign serving, and says so (no lane set: nothing zeroed). Live fix
 *               10-08 — the Min-bid hour also sets every placement lane to 0 % (minBidLanes), as rank-defend did: a
 *               3¢ floor at 300 % top of search still cost 12¢. AB-2 — and dynamic bidding "up and down"
 *               (AUTO_FOR_SALES), which may still add up to +100 % at top of search over the floor, goes to "down only"
 *               for the hour (the stop recipe, stop-recipe.ts: the strategy's switch and its why are decided there).
 *   lanes       the placement % the hour names: a blended target sets all three lanes (an undeclared one to 0, as
 *               buildBlendedAdjustments does), a single-placement target its one lane (the others stay as they are;
 *               AB-2 — after a Min-bid hour or a stop, as they were before it: the stop's memory, stop-recipe.ts).
 *               Each lane's CPC ceiling is the target's, held with Amazon's dynamic bidding (rank-controller.ts
 *               laneHeadroom; recipe.ts placementsFor caps the % so base × (1 + p) × dynamic stays within it)
 *   base bid    an hour that sets the ad groups' base bid ('absolute', 'deltaPct') is not carried out: the brain sets the
 *               bids from the goal. A campaign with such an hour cannot go LIVE (enrollment.ts); one that gains it later
 *               is told so in the why.
 *
 * The older family plan (ProductRankPlan) is not read here: a campaign one governs cannot go LIVE.
 */
import { laneHeadroom, type RankTargetSpec } from '../rank-controller.js'
import { MANAGED_PLACEMENTS, PLACEMENT_PRODUCT, PLACEMENT_TOP } from '../ads-placement-math.js'
import type { Lane, LaneName } from './recipe.js'
import type { Overrides } from './decide.js'

/** The Min-bid floor when the target names none: rank-defend's legacy 2¢. */
export const DEFAULT_MIN_BID_FLOOR_CENTS = 2

/** One campaign's hourly plan at this hour. */
export interface PlanHour {
  scheduleId: string
  /** The plan's name, for the why (its group's, else the schedule's). */
  name: string
  /** The target the hour names (null: the plan holds nothing at this hour). */
  key: string | null
  /** The target's spec with the campaign's overrides; null with no key, or a key whose target is gone. */
  spec: RankTargetSpec | null
  /** The dated event that replaced the week, by name. */
  event: string | null
  /**
   * Owner decision A (10-10) — the hours of today (the plan's time zone) the current target runs without a break, `toHour`
   * exclusive: the keyword bid is held to THIS hour's ceiling (decide.ts holdToHour), named "the plan at 14:00–16:00".
   * (Before: the day's lowest ceiling held it all day.)
   */
  window?: { fromHour: number; toHour: number } | null
  /**
   * BB-22 — the learned hour factor this hour carries out (NEXUS_BID_BRAIN_HOUR_FACTORS=on, hour-factors-store.ts): the
   * spec's lanes are already the learned ones, inside the approved cell's limits; these words join the plan's note.
   */
  learned?: string | null
  /**
   * BB-22 — the approved cell's spec when `spec` holds the learned lanes: BB-18's stack ceiling (the most a click can cost
   * against the base bid, facts.ts) still reads the approved cell, so the learned factor moves the placements only, never
   * the keyword bids.
   */
  approved?: RankTargetSpec | null
}

/**
 * The lowest CPC ceiling among a day's serving targets (a Min-bid hour sets none). Pure. Owner decision A (10-10) — no longer
 * the keyword bid's ceiling (this hour's is, decide.ts holdToHour); the bidding-strategy check (brain/bidding-mode-load.ts)
 * still reads it.
 */
export function dayCeilingCents(specs: ReadonlyArray<Pick<RankTargetSpec, 'pause' | 'bidMode' | 'maxCpcCents'> | null>): number | null {
  const caps = specs.filter((s): s is NonNullable<typeof s> => !!s && !isMinBidSpec(s) && s.maxCpcCents != null && s.maxCpcCents > 0).map((s) => s.maxCpcCents!)
  return caps.length ? Math.min(...caps) : null
}

/** Owner decision A (10-10) — the run of hours around `hour` with the same target (`keys`: the target of each hour 0–23). Pure. */
export function hourWindow(keys: ReadonlyArray<string | null>, hour: number): { fromHour: number; toHour: number } {
  let from = hour
  while (from > 0 && keys[from - 1] === keys[hour]) from--
  let to = hour + 1
  while (to < 24 && keys[to] === keys[hour]) to++
  return { fromHour: from, toHour: to }
}

/** "the plan at 14:00–16:00" — whose ceiling holds the keyword bid this hour (decide.ts holdToHour). Pure. */
export function hourWords(w: { fromHour: number; toHour: number } | null | undefined): string {
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
  return w ? `the plan at ${hh(w.fromHour)}–${hh(w.toHour)}` : 'the plan this hour'
}

const LANE_OF: Record<string, LaneName> = { [PLACEMENT_TOP]: 'TOP_OF_SEARCH', [PLACEMENT_PRODUCT]: 'PRODUCT_PAGE' }
/** The bidding-API placement → the brain's lane name (anything else is rest of search). */
export const laneOf = (placement: string): LaneName => LANE_OF[placement] ?? 'REST_OF_SEARCH'
const PLACEMENT_OF: Record<LaneName, string> = { TOP_OF_SEARCH: PLACEMENT_TOP, PRODUCT_PAGE: PLACEMENT_PRODUCT, REST_OF_SEARCH: 'PLACEMENT_REST_OF_SEARCH' }
/** The brain's lane name → the bidding-API placement. */
export const placementOf = (lane: LaneName): string => PLACEMENT_OF[lane]

/** A target whose hour floors every bid: Min bid, or a base bid `suppress`. */
export const isMinBidSpec = (spec: Pick<RankTargetSpec, 'pause' | 'bidMode'>): boolean => spec.pause === true || spec.bidMode === 'suppress'
/** A target that moves the ad groups' base bid: the brain does not carry it out. */
export const setsBaseBid = (spec: Pick<RankTargetSpec, 'bidMode'>): boolean => spec.bidMode === 'absolute' || spec.bidMode === 'deltaPct'

/** Live fix 10-08 — a Min-bid hour's lanes: every managed placement at 0 %, so no placement % raises the floor again. */
export function minBidLanes(biddingStrategy?: string | null): Lane[] {
  return MANAGED_PLACEMENTS.map((p) => ({ lane: laneOf(p), planPct: 0, maxCpcCents: null, baseCeilingCents: null, dynamic: laneHeadroom(biddingStrategy, p) }))
}

/** What the hour gives `decide`: the lanes, a Min-bid floor, and the plan in words. Pure. */
export interface PlanFacts {
  lanes: Lane[]
  minBidHour: Overrides['minBidHour']
  note: string
  /** The hour sets a base bid the brain does not carry out (said in the why). */
  baseBidIgnored: boolean
  /** BB-22 — the approved cell's lanes when `lanes` are the learned ones (the stack ceiling reads these); absent: `lanes`. */
  ceilingLanes?: Lane[]
}

/**
 * The hour as the brain's input. `entriesToday`: the campaign's Min-bid entries this UTC day; `inMinBid`: it is in a
 * Min-bid hour already (its keywords sit at the floor the brain put them at), so this hour is no new entry.
 */
export function planFacts(hour: PlanHour, campaign: { biddingStrategy?: string | null }, opts: { entriesToday: number; inMinBid: boolean; maxEntries: number }): PlanFacts | null {
  const spec = hour.spec
  if (!spec) return null
  const named = `hourly plan ${hour.name}${hour.event ? ` (event ${hour.event})` : ''}: ${spec.key}${hour.learned ? ` — ${hour.learned}` : ''}`
  if (isMinBidSpec(spec)) {
    if (!opts.inMinBid && opts.entriesToday >= opts.maxEntries) {
      return { lanes: [], minBidHour: null, note: `${named} — kept serving: it entered Min bid ${opts.entriesToday === 1 ? 'once' : `${opts.entriesToday} times`} today (UTC), at most ${opts.maxEntries} a day`, baseBidIgnored: false }
    }
    // Live fix 10-08 — every placement lane to 0 % with the floor (written in the same tick as the keyword floors). AB-2 —
    // the bidding strategy's part (up and down → down only for the hour) is the stop recipe's, with its own why.
    return { lanes: minBidLanes(campaign.biddingStrategy), minBidHour: { floorCents: spec.floorBidCents ?? DEFAULT_MIN_BID_FLOOR_CENTS }, note: `${named} — every placement at 0 %`, baseBidIgnored: false }
  }
  const declared = spec.lanes?.length
    ? new Map(spec.lanes.map((l) => [l.placement, l.biasPct ?? 0]))
    : new Map([[spec.placement, spec.biasPct ?? 0]])
  // A blended target owns all three lanes (undeclared → 0); a single-placement target only its own.
  const placements = spec.lanes?.length ? [...MANAGED_PLACEMENTS] : [spec.placement]
  const lanes: Lane[] = placements.map((p) => ({
    lane: laneOf(p),
    planPct: Math.max(0, Math.min(900, Math.round(declared.get(p) ?? 0))),
    maxCpcCents: spec.maxCpcCents ?? null,
    // Owner decision A (10-10) — the keyword bid's ceiling is this hour's (it was the day's lowest).
    baseCeilingCents: spec.maxCpcCents ?? null,
    dynamic: laneHeadroom(campaign.biddingStrategy, p),
  }))
  const baseBidIgnored = setsBaseBid(spec)
  // BB-22 — learned lanes: the approved cell's lanes stay what the stack ceiling reads.
  const ceilingLanes = hour.approved ? planFacts({ ...hour, spec: hour.approved, approved: null, learned: null }, campaign, opts)?.lanes : undefined
  return { lanes, minBidHour: null, note: `${named}${baseBidIgnored ? ' (its base bid is not applied: the brain sets the bids from the goal)' : ''}`, baseBidIgnored, ...(ceilingLanes ? { ceilingLanes } : {}) }
}

