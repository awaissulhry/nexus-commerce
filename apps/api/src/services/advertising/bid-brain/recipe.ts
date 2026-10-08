/**
 * BID BRAIN BB-1 — the recipe: goal bid × hour factor, then the rule inputs, one step per new data day, inside the
 * limits; and the placement % of each lane, capped by the lane's CPC ceiling.
 *
 *   goal bid   aim × CR̂ × AOV̂ ÷ r̂            (r̂ = paid CPC ÷ bid; the CPC the aim affords, as a bid)
 *   hour       × f_h                           (the day's lowest serving factor of the hourly plan; 1 without one)
 *   inputs     the lowest ceiling and the highest floor of the rule directives (BB-9); a floor above a ceiling loses
 *              to it and the clash is said once — never ping-pong at Amazon
 *   step       at most maxChangePct × confidence from the day's anchor — the bid before the first step on this data
 *              day — so a rerun on the same evidence lands on the same bid (no `current × ratio` compounding)
 *   limits     strategy lowest/highest bid, the campaign's own bounds, the 5¢ engine floor, and a lane ceiling: the
 *              base bid never exceeds a lane's max CPC (C2: a plan asked for a bid no one could set)
 *
 * Pure: no database, no clock.
 */
import { crLowerBound80, type NodeEstimate } from './estimator.js'

/** Nexus's engine floor (ads-mutation.service.ts): an engine never writes below it; a stop's low bid is an override. */
export const ENGINE_FLOOR_CENTS = 5
/** The step when the strategy names no largest change. */
export const DEFAULT_MAX_CHANGE_PCT = 25
/** A goal write must move the bid by at least 2¢ and 5 %. */
export const MIN_WRITE_CENTS = 2
export const MIN_WRITE_SHARE = 0.05
/** A raise above the parent's bid needs this many orders of the target's own. */
export const RAISE_MIN_ORDERS = 2

export interface BidLimits {
  /** The ads strategy's lowest and highest bid and largest change per action (integer percent). */
  minBidCents?: number | null
  maxBidCents?: number | null
  maxChangePct?: number | null
  /** The campaign's own bounds (Campaign.minBidCents / maxBidCents). */
  campaignMinCents?: number | null
  campaignMaxCents?: number | null
}

/**
 * A rule's bid action as an input (BB-9): a ceiling or a floor on this target. A SHARE_FLOOR (share of voice, rank) is a
 * floor held to hi × 1.25 instead of the band top.
 */
export interface Directive {
  kind: 'CEILING' | 'FLOOR' | 'SHARE_FLOOR'
  cents: number
  /** Who asked: "rule:Lower bids on clicks without sales". */
  source: string
}

/** BB-9 — a placement rule as an input: a cap or a floor on one lane's placement %. */
export interface LaneDirective {
  lane: LaneName
  kind: 'CEILING' | 'FLOOR'
  pct: number
  source: string
}

export type LaneName = 'TOP_OF_SEARCH' | 'PRODUCT_PAGE' | 'REST_OF_SEARCH'

/** One placement lane of the campaign as the hourly plan shapes it (BB-7). */
export interface Lane {
  lane: LaneName
  /** The plan's placement % for the hour (0 = no uplift). */
  planPct: number
  /** The lane's CPC ceiling in cents; null = none. */
  maxCpcCents?: number | null
  /** CR̂ of the lane ÷ CR̂ of all placements, once the placement report has data; null = not known yet. */
  crRatio?: number | null
}

/** The bid at which a pooled estimate meets an ACoS: acos × CR̂ × AOV̂ ÷ r̂ (cents, unrounded). */
export function bidForAcos(acos: number, cr: number, aovCents: number, ratio: number): number {
  return ratio > 0 ? (acos * cr * aovCents) / ratio : 0
}

/** The ACoS a bid is expected to give: bid × r̂ ÷ (CR̂ × AOV̂). Null when no value per click is known. */
export function expectedAcos(bidCents: number, cr: number, aovCents: number | null, ratio: number): number | null {
  const valuePerClick = aovCents != null ? cr * aovCents : 0
  return valuePerClick > 0 ? (bidCents * ratio) / valuePerClick : null
}

/**
 * The minimum-data rule for a raise above the parent's bid: none with fewer than RAISE_MIN_ORDERS orders of its own;
 * with them, at most the bid where the ACoS at the 80 % lower bound of its conversion rate reaches the band top.
 */
export function raiseCap(args: { wantCents: number; parentCents: number; node: NodeEstimate; aovCents: number; ratio: number; hi: number }): { cents: number; why: string | null } {
  const { wantCents, parentCents, node } = args
  if (wantCents <= parentCents) return { cents: wantCents, why: null }
  if (node.orders < RAISE_MIN_ORDERS) return { cents: parentCents, why: `held at the parent's bid (${node.orders < 1 ? 'no orders' : 'one order'} of its own)` }
  const safe = bidForAcos(args.hi, crLowerBound80(node), args.aovCents, args.ratio)
  if (safe >= wantCents) return { cents: wantCents, why: null }
  return { cents: Math.max(parentCents, safe), why: 'raise held where the cautious ACoS meets the band top' }
}

/** The lowest ceiling and the highest floor win; a floor above a ceiling loses to it, and the clash is named. */
export function applyDirectives(cents: number, directives: readonly Directive[] = [], floorCapCents?: number | null, shareCapCents?: number | null): { cents: number; applied: string[]; clash: string | null } {
  const ceilings = directives.filter((d) => d.kind === 'CEILING' && d.cents > 0)
  // A floor never sits above the band top (design §2: no higher than the top of the band); a share floor (BB-9) never
  // above hi × 1.25. Each is held to its own cap first, then the highest wins.
  const capped = (d: Directive): Directive => {
    const cap = d.kind === 'SHARE_FLOOR' ? shareCapCents ?? floorCapCents : floorCapCents
    return cap != null && d.cents > cap ? { ...d, cents: Math.floor(cap) } : d
  }
  const floors = directives.filter((d) => (d.kind === 'FLOOR' || d.kind === 'SHARE_FLOOR') && d.cents > 0).map(capped)
  const ceiling = ceilings.length ? ceilings.reduce((a, b) => (b.cents < a.cents ? b : a)) : null
  let floor = floors.length ? floors.reduce((a, b) => (b.cents > a.cents ? b : a)) : null
  const applied: string[] = []
  let out = cents
  let clash: string | null = null
  if (floor && ceiling && floor.cents > ceiling.cents) {
    clash = `${floor.source} ${floor.kind === 'SHARE_FLOOR' ? 'share floor' : 'floor'} ${floor.cents}¢ is above ${ceiling.source} ceiling ${ceiling.cents}¢ — the ceiling wins`
    floor = null
  }
  if (floor && out < floor.cents) { out = floor.cents; applied.push(`${floor.kind === 'SHARE_FLOOR' ? 'share floor' : 'floor'} ${floor.cents}¢ (${floor.source})`) }
  if (ceiling && out > ceiling.cents) { out = ceiling.cents; applied.push(`ceiling ${ceiling.cents}¢ (${ceiling.source})`) }
  return { cents: out, applied, clash }
}

/** The step: at most `maxPct × confidence` away from the anchor. */
export function stepFrom(anchorCents: number, wantCents: number, maxPct: number, confidence: number): { cents: number; held: boolean } {
  const share = Math.max(0, Math.min(1, confidence)) * (maxPct / 100)
  const lo = anchorCents * (1 - share)
  const hi = anchorCents * (1 + share)
  if (wantCents < lo) return { cents: lo, held: true }
  if (wantCents > hi) return { cents: hi, held: true }
  return { cents: wantCents, held: false }
}

/** The limits as one range: the stricter side of each wins, and where they cross the lower one (it spends less). */
export function limitRange(limits: BidLimits, lanes: readonly Lane[] = []): { lower: number; upper: number | null; upperFrom: string | null; lowerFrom: string } {
  let lower = ENGINE_FLOOR_CENTS
  let lowerFrom = 'the 5¢ engine floor'
  for (const [v, from] of [[limits.minBidCents, 'the strategy lowest bid'], [limits.campaignMinCents, "the campaign's lowest bid"]] as const) {
    if (v != null && v > lower) { lower = v; lowerFrom = from }
  }
  let upper: number | null = null
  let upperFrom: string | null = null
  const uppers: Array<[number | null | undefined, string]> = [
    [limits.maxBidCents, 'the strategy highest bid'],
    [limits.campaignMaxCents, "the campaign's highest bid"],
    ...lanes.map((l): [number | null | undefined, string] => [l.maxCpcCents, `the ${laneWords(l.lane)} CPC ceiling`]),
  ]
  for (const [v, from] of uppers) {
    if (v != null && v > 0 && (upper == null || v < upper)) { upper = v; upperFrom = from }
  }
  return { lower, upper, upperFrom, lowerFrom }
}

export function clampToRange(cents: number, range: ReturnType<typeof limitRange>): { cents: number; held: string | null } {
  if (range.upper != null && cents > range.upper) return { cents: Math.max(range.upper, ENGINE_FLOOR_CENTS), held: range.upperFrom }
  if (cents < range.lower && (range.upper == null || range.lower <= range.upper)) return { cents: range.lower, held: range.lowerFrom }
  return { cents, held: null }
}

export const laneWords = (lane: LaneName): string => (lane === 'TOP_OF_SEARCH' ? 'top-of-search' : lane === 'PRODUCT_PAGE' ? 'product-page' : 'rest-of-search')

export interface PlacementDecision {
  lane: LaneName
  planPct: number
  pct: number
  held: string | null
}

/**
 * Each lane's placement %: the plan's, held so that bid × (1 + p) stays within the lane's CPC ceiling, and — once the
 * placement report has data — so that 1 + p ≤ CR̂_lane ÷ CR̂_all × hi ÷ aim.
 */
export function placementsFor(bidCents: number, lanes: readonly Lane[], goal: { aim: number; hi: number }): PlacementDecision[] {
  return lanes.map((l) => {
    let pct = Math.max(0, l.planPct)
    let held: string | null = null
    if (l.maxCpcCents != null && l.maxCpcCents > 0 && bidCents > 0) {
      const cap = Math.max(0, Math.floor((l.maxCpcCents / bidCents - 1) * 100))
      if (pct > cap) { pct = cap; held = `the ${laneWords(l.lane)} CPC ceiling ${l.maxCpcCents}¢` }
    }
    if (l.crRatio != null && l.crRatio > 0 && goal.aim > 0) {
      const cap = Math.max(0, Math.floor((l.crRatio * (goal.hi / goal.aim) - 1) * 100))
      if (pct > cap) { pct = cap; held = `the ${laneWords(l.lane)} conversion (×${Math.round(l.crRatio * 100) / 100})` }
    }
    return { lane: l.lane, planPct: l.planPct, pct, held }
  })
}

/**
 * BB-9 — the placement rules' caps and floors on the plan's lanes: the lowest cap and the highest floor of each lane win,
 * and a floor above a cap loses to it. A floor on a lane the plan does not shape adds that lane (from 0 %). Pure.
 */
export function applyLaneDirectives(lanes: readonly Lane[] = [], directives: readonly LaneDirective[] = []): Lane[] {
  if (!directives.length) return [...lanes]
  const out = new Map<LaneName, Lane>(lanes.map((l) => [l.lane, { ...l }]))
  const names = new Set<LaneName>(directives.map((d) => d.lane))
  for (const name of names) {
    const mine = directives.filter((d) => d.lane === name && Number.isFinite(d.pct) && d.pct >= 0)
    const caps = mine.filter((d) => d.kind === 'CEILING').map((d) => d.pct)
    const floors = mine.filter((d) => d.kind === 'FLOOR').map((d) => d.pct)
    const cap = caps.length ? Math.min(...caps) : null
    let floor = floors.length ? Math.max(...floors) : null
    if (floor != null && cap != null && floor > cap) floor = null
    const lane = out.get(name) ?? (floor != null ? { lane: name, planPct: 0 } : null)
    if (!lane) continue
    let pct = Math.max(0, lane.planPct)
    if (floor != null && pct < floor) pct = floor
    if (cap != null && pct > cap) pct = cap
    out.set(name, { ...lane, planPct: pct })
  }
  return [...out.values()]
}

