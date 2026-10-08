/**
 * ONE BRAIN AB-2 — the stop recipe of a campaign the bid brain owns (design 2026-10-08-ads-one-brain/DESIGN.md §2.4,
 * §2.11). A stop is a 3¢ bid only when nothing lifts it again at Amazon: the effective bid is base × (1 + placement %) ×
 * Amazon's dynamic bidding, so a 3¢ floor at 900 % top of search under "up and down" may cost 3¢ × 10 × 2 = 60¢. While a
 * stop or a Min-bid hour holds the WHOLE campaign:
 *
 *   lanes      every placement lane → 0 % (a Min-bid hour since #515; now every stop), the lanes live when it began saved
 *              first (Campaign.suppressedFromPlacements)
 *   strategy   AUTO_FOR_SALES ("up and down") → LEGACY_FOR_SALES ("down only"), the strategy saved first
 *              (Campaign.suppressedFromBiddingStrategy). Fixed (MANUAL) and down only stay: neither raises a bid
 *   end        the lanes come back in one write — the hourly plan's own lanes this hour over the saved ones — and the
 *              strategy goes back to the one saved (the keywords' bids come back from their own memory: decide.ts restore)
 *
 *   which stop  every keyword of the campaign that is not braked (a paused ad group) is floored by a stop — a budget stop
 *               or the monthly cap, suppress-campaign, a playbook STOP, a declared stop or STOP hold, a keyword's own
 *               remembered stop — by stock (not buyable: out of stock, no Buy Box) or by the hourly plan's Min-bid hour
 *               (counted with the plan's hour, as since #515). An ad group floored on its own leaves the campaign serving,
 *               and its lanes and strategy as they are
 *   Owner locks AB-1 (brain/settings.ts) — a stop LOWERS past them (lanes to 0 %, down only), as a stop beats a pinned
 *               bid; only the give-back obeys them: a locked lever goes back to the Owner's value (the lock's, else what it
 *               held before the stop), never to the brain's plan. Locks that cannot be read hold the give-back (nothing is
 *               dropped; the next tick tries again). The campaign's own pins (pinPlacement; pinBids, the strategy being a bids
 *               setting) hold both ways: the gate refuses those writes, so none is asked. The why says each
 *   a person    a person's own strategy (his edit or a request he approved) is a STRATEGY hold for 60 days, like his bid
 *               (design §2.10): the brain leaves the strategy alone — no switch down — until it ends; then the recipe
 *               applies again if the stop still runs. A stop that ends under his hold drops its saved strategy
 *   anti-flap   a strategy switch at most MAX_STRATEGY_SWITCHES_PER_DAY times a UTC day per campaign (a stop on and off).
 *               The switch down is the stop's brake and is never held back; once the campaign has switched twice today
 *               the switch back up waits: it stays down only until the next UTC day, and the why says so
 *   a change    a strategy someone changed during the stop (anything but the down only the stop set) is left as it is when
 *               the stop ends, its memory dropped
 *   the stack   while the memory is kept, the brain measures the bid stack from it (facts.ts: the strategy and the lanes
 *               the campaign serves with), so the limits and the give-back are those of the campaign without the stop
 *   rollback    the memory is read only while the brain owns the campaign; whatever ends that gives it back and clears it:
 *               op shadow and give-back (as the approver), op live (first, or it is refused), and — the server switch
 *               off, a product leaving the brain — the restore path every stop's owner already runs (restoreCampaignBids)
 *
 * Pure: shadow.ts assembles, live-writer.ts writes, stop-memory.ts keeps the memory.
 */
import { laneHeadroom } from '../rank-controller.js'
import { MANAGED_PLACEMENTS } from '../ads-placement-math.js'
import type { Decision, TargetFacts } from './decide.js'

/** Amazon's "up and down" (dynamic bidding up to +100 % at the top of search, +50 % elsewhere). */
export const UP_AND_DOWN = 'AUTO_FOR_SALES'
/** Amazon's "down only": never above the bid. What a stop runs on. */
export const DOWN_ONLY = 'LEGACY_FOR_SALES'
/** A campaign's bidding strategy switches at most this many times a UTC day: one stop on and off. */
export const MAX_STRATEGY_SWITCHES_PER_DAY = 2

export type Placement = { placement: string; percentage: number }
export type StopKind = 'stop' | 'stock' | 'min_bid_hour'
/** What holds the whole campaign at its floor this tick, in words for the why. */
export interface CampaignStop { kind: StopKind; words: string }

const STOP_RANK: Record<StopKind, number> = { stop: 3, stock: 2, min_bid_hour: 1 }

/** One keyword's stop this tick (its overrides, and a Min-bid hour that decided it); null: it serves. */
export function keywordStop(f: Pick<TargetFacts, 'overrides'>, d: Pick<Decision, 'layer'>): CampaignStop | null {
  const o = f.overrides ?? {}
  if (o.stop) return { kind: 'stop', words: `stop by ${o.stop.by}` }
  if (o.stock && 'notBuyable' in o.stock) return { kind: 'stock', words: `not buyable (${o.stock.by})` }
  if (o.minBidHour || d.layer === 'min_bid_hour') return { kind: 'min_bid_hour', words: 'Min-bid hour' }
  return null
}

/**
 * The stop holding the whole campaign: every keyword that is not braked is floored by one. Named by the kind that floors
 * the most keywords (a tie: a stop, then stock, then a Min-bid hour) — a Min-bid hour over a campaign with one keyword
 * under its own stop is the Min-bid hour. Null when a keyword serves, when every keyword is braked, or when the only
 * stops are Min-bid floors without the plan's hour (`planHour`: a floor mark alone writes no lane, as since #515).
 */
export function campaignStopOf(items: ReadonlyArray<{ f: Pick<TargetFacts, 'overrides' | 'brakes'>; d: Pick<Decision, 'layer'> }>, planHour: boolean): CampaignStop | null {
  const counts: Record<StopKind, number> = { stop: 0, stock: 0, min_bid_hour: 0 }
  const first: Partial<Record<StopKind, CampaignStop>> = {}
  let any = false
  for (const { f, d } of items) {
    if (f.brakes?.length) continue
    any = true
    const s = keywordStop(f, d)
    if (!s) return null
    counts[s.kind]++
    first[s.kind] ??= s
  }
  if (!any || (!counts.stop && !counts.stock && !planHour)) return null
  const kind = (Object.keys(counts) as StopKind[]).filter((k) => counts[k] > 0).sort((a, b) => counts[b] - counts[a] || STOP_RANK[b] - STOP_RANK[a])[0]
  return first[kind] ?? null
}

/** The saved lanes as stored (the valid entries); null when no stop holds them (an empty list: none was set). */
export function readSavedLanes(raw: unknown): Placement[] | null {
  if (!Array.isArray(raw)) return null
  return raw
    .filter((p): p is { placement: string; percentage: unknown } => typeof (p as { placement?: unknown })?.placement === 'string')
    .map((p) => ({ placement: p.placement, percentage: Number(p.percentage) }))
    .filter((p) => Number.isFinite(p.percentage))
}

/** The saved lanes as one full array to give back: every managed lane (one not listed at 0), any other as saved. */
export function fullLanes(saved: readonly Placement[]): Placement[] {
  const valueOf = (p: string) => saved.find((s) => s.placement === p)?.percentage ?? 0
  const managed = MANAGED_PLACEMENTS as readonly string[]
  return [...MANAGED_PLACEMENTS.map((p) => ({ placement: p, percentage: valueOf(p) })), ...saved.filter((s) => !managed.includes(s.placement))]
}

/**
 * The most one click may cost against a base bid (BB-18's stack): base × (1 + the lane's %) × Amazon's dynamic bidding on
 * that lane, the highest lane. 3¢ at 900 % top of search under "up and down" → 60¢; with the recipe → 3¢.
 */
export function stackMaxCents(baseCents: number, placements: readonly Placement[], biddingStrategy: string | null | undefined): number {
  const pctOf = (p: string) => Math.max(0, placements.find((x) => x.placement === p)?.percentage ?? 0)
  return Math.max(...MANAGED_PLACEMENTS.map((p) => baseCents * (1 + pctOf(p) / 100) * laneHeadroom(biddingStrategy, p)))
}

/** "up and down" · "down only" · "fixed" — Amazon's bidding strategies in the console's words. */
export const strategyWords = (s: string | null | undefined): string =>
  s === UP_AND_DOWN ? 'up and down' : s === DOWN_ONLY ? 'down only' : s === 'MANUAL' ? 'fixed' : String(s ?? 'unknown')

const stopNoun = (stop: CampaignStop) => (stop.kind === 'min_bid_hour' ? 'the Min-bid hour' : 'the stop')

/** What the brain does with one campaign's bidding strategy this tick. */
export interface StrategyFacts {
  /** The stop holding the whole campaign now; null: it serves. */
  stop: CampaignStop | null
  /** Campaign.biddingStrategy now. */
  current: string | null
  /** Campaign.suppressedFromBiddingStrategy: what a stop switched it from. */
  saved: string | null
  /** The Owner's lock of the strategy (AB-1): its words and his value (null: as it was). A stop passes it; the give-back obeys it. */
  lock?: { words: string; value: string | null } | null
  /** The Owner's locks could not be read this tick: the give-back waits (nothing dropped). */
  locksUnreadable?: boolean
  /** The campaign's bids pin (pinBids), in words: the gate refuses an automatic strategy write there, so none is asked. */
  pinned?: string | null
  /** A person's own strategy (a STRATEGY hold, design §2.10), in words: the brain leaves it until the hold ends. */
  held?: string | null
  /** The campaign's strategy switches by the brain this UTC day. */
  switchesToday: number
}

export type StrategyStep =
  /** Switch: `floor` down only for a stop (`remember` the strategy first, when no memory holds one), `restore` back after it. */
  | { do: 'switch'; to: string; kind: 'floor' | 'restore'; remember: string | null; why: string }
  /** Drop the memory, write nothing (a person's strategy, someone changed it meanwhile, or already back). */
  | { do: 'forget'; why: string }
  /** Write nothing, keep the memory (a person's hold or the pin during a stop, unreadable locks, the anti-flap). */
  | { do: 'hold'; why: string }

const ABOVE_FLOOR = 'Amazon may still add up to +100 % at the top of search over the floor'

/**
 * The strategy step of one campaign; null: nothing to do or say. Pure.
 *   during a stop   up and down → down only, past the Owner's lock (a stop beats a pinned bid: the same precedent); not
 *                   past a person's own strategy (his hold) or the bids pin (the gate would refuse it) — each said
 *   after it        back to the strategy saved — to the Owner's locked value where he locked it (his lock wins over the
 *                   anti-flap) — unless a person set his own since (the memory is dropped), the locks could not be read
 *                   (it waits), the pin holds (it waits), or the anti-flap holds it to tomorrow
 */
export function strategyStep(s: StrategyFacts): StrategyStep | null {
  if (s.stop) {
    if (s.current !== UP_AND_DOWN) return null
    if (s.held) return { do: 'hold', why: `the bidding strategy is a person's own (held by ${s.held}): kept up and down — ${ABOVE_FLOOR}` }
    if (s.pinned) return { do: 'hold', why: `the bidding strategy is ${s.pinned}: kept up and down — ${ABOVE_FLOOR}` }
    const passes = s.lock ? ` — the stop passes the Owner's lock (${s.lock.words}), as a stop passes a pinned bid; his value comes back when it ends` : ''
    return { do: 'switch', to: DOWN_ONLY, kind: 'floor', remember: s.saved ? null : s.current, why: `bidding strategy up and down → down only while ${stopNoun(s.stop)} lasts (Amazon then never raises the floor)${passes}` }
  }
  if (!s.saved) return null
  if (s.held) return { do: 'forget', why: `the bidding strategy is a person's own (held by ${s.held}): left ${strategyWords(s.current)} (the ${strategyWords(s.saved)} the stop saved is dropped)` }
  if (s.locksUnreadable) return { do: 'hold', why: 'the Owner\'s locks could not be read: the bidding strategy\'s give-back waits for the next tick (the saved strategy is kept)' }
  if (s.pinned) return { do: 'hold', why: `the bidding strategy is ${s.pinned}: left ${strategyWords(s.current)} until the pin is lifted (the ${strategyWords(s.saved)} the stop saved is kept)` }
  if (s.lock) {
    const target = s.lock.value ?? s.saved
    if (s.current === target) return { do: 'forget', why: `the bidding strategy is the Owner's value (${strategyWords(target)}) again` }
    return { do: 'switch', to: target, kind: 'restore', remember: null, why: `the stop ended: the bidding strategy goes back to the Owner's value, ${strategyWords(target)} (${s.lock.words})` }
  }
  if (s.current === s.saved) return { do: 'forget', why: `the bidding strategy is ${strategyWords(s.saved)} again` }
  if (s.current !== DOWN_ONLY) return { do: 'forget', why: `the bidding strategy changed during the stop (now ${strategyWords(s.current)}): left as it is` }
  if (s.switchesToday >= MAX_STRATEGY_SWITCHES_PER_DAY) {
    return { do: 'hold', why: `bidding strategy kept down only until tomorrow (UTC): it switched ${s.switchesToday} times today, at most ${MAX_STRATEGY_SWITCHES_PER_DAY} a day (one stop on and off)` }
  }
  return { do: 'switch', to: s.saved, kind: 'restore', remember: null, why: `the stop ended: bidding strategy back to ${strategyWords(s.saved)}` }
}

/**
 * What a stop's memory still owes the campaign: the lanes (saved, and the live ones differ) and the strategy (saved, and
 * the campaign still runs on the stop's down only). Settled memory owes nothing. Pure.
 */
export function stopMemoryOwed(c: { placements?: readonly Placement[] | null; biddingStrategy?: string | null; savedPlacements?: readonly Placement[] | null; savedStrategy?: string | null }): { lanes: boolean; strategy: boolean } {
  const live = (p: string) => Math.max(0, c.placements?.find((x) => x.placement === p)?.percentage ?? 0)
  const lanes = !!c.savedPlacements && fullLanes(c.savedPlacements).some((l) => (MANAGED_PLACEMENTS as readonly string[]).includes(l.placement) && l.percentage !== live(l.placement))
  const strategy = !!c.savedStrategy && c.biddingStrategy === DOWN_ONLY && c.savedStrategy !== DOWN_ONLY
  return { lanes, strategy }
}
