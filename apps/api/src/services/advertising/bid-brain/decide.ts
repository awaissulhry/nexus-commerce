/**
 * BID BRAIN BB-1 — `decide(facts) → Decision`: the one place a keyword bid is decided, with its one-line "why".
 *
 *   brakes     first of all: the kill switch, a halt, the dial OFF, the breaker, data older than 48 hours, a paused or
 *              not-allowlisted campaign — nothing is written, and the reason is said
 *   overrides  the first that applies decides, in this fixed order:
 *                STOP ▸ PIN/HOLD ▸ STOCK/RETAIL ▸ AUTO-UNDO FREEZE ▸ PHASE ▸ MIN-BID HOUR ▸ MONEY ▸ INTRADAY (BB-17)
 *              when several apply the lower bid wins, except a pin (left alone, unless a stop comes first). MONEY (batch 2
 *              fix): the money brain's brake above 100 % of the month's pace — one step down a data day (money-brake.ts).
 *              INTRADAY (BB-17): the intraday brakes (intraday.ts); a decision its bid decides carries its layer, so the
 *              brake's memory (the bid before it) holds whichever override is named first
 *   restore    BB-8 — no override applies any more, but the last decision was one that lowered the bid (a stop, stock, a
 *              phase floor, a Min-bid hour) and the bid still sits there: the bids go back as if the stop never happened —
 *              the goal decided from the bid before the stop (one step from it), else that bid, else the goal itself
 *   goal       otherwise the recipe (recipe.ts) from the pooled estimate (estimator.ts) and the goal (goal.ts); it writes
 *              only when the expected ACoS at today's bid is outside the band and the bid moves by ≥ 2¢ and ≥ 5 %, and a
 *              bid outside a hard limit is always brought back inside it
 *   share      Lane 5 — with a target top-of-search impression share (`share`, share.ts; absent: off, nothing changes),
 *              after the limits and the rule inputs and before the band: the band top wins (an ACoS above it goes to the
 *              goal, which lowers); a reading that counts raises one step below target − 5 points (capped at the band
 *              top's bid, the highest limit and the top-of-search lane), lowers one step above target + 5, holds within;
 *              right after its own move it waits; a reading that does not count moves nothing and the goal decides, the
 *              why saying why the share held. The overrides, the brakes and the raise cap decide before it.
 *
 * Idempotent: the same facts give the same decision. The step is taken from the bid before the brain's first step on
 * the newest data day (`lastStep`), so a rerun on unchanged evidence never compounds (C3: 33→25→19→14¢ in six hours).
 * Pure: no database, no clock.
 */
import { estimate, laneCpcRatio, type Estimate, type PoolNode } from './estimator.js'
import { goalWords, isGoal, resolveGoal, type Goal, type GoalInputs, type GoalRefusal } from './goal.js'
import { readingWords, shareMove, SHARE_NEXT_LEVER, tosLaneCap, type ShareFacts } from './share.js'
import {
  applyDirectives,
  applyLaneDirectives,
  bidForAcos,
  clampToRange,
  DEFAULT_MAX_CHANGE_PCT,
  expectedAcos,
  limitRange,
  MIN_WRITE_CENTS,
  MIN_WRITE_SHARE,
  placementsFor,
  raiseCap,
  stepFrom,
  type BidLimits,
  type Directive,
  type Lane,
  type LaneDirective,
  type PlacementDecision,
} from './recipe.js'

/** The overrides in force for one target. Each is absent when it does not apply. */
export interface Overrides {
  /** suppress-campaign, a monthly cap reached, a playbook STOP: the stop bid. */
  stop?: { bidCents: number; by: string } | null
  /** pinBids, a person's own bid, a Claude request a person approved: left alone until `until`. */
  /**
   * BB-10 re-review — `soft`: auto-undo's 7-day pin after it put back a brain change. A floor (stop, stock, phase, Min-bid
   * hour) wins over it, and so does the give-back after one; a person's pin keeps its rank (it holds against all but a stop).
   */
  pin?: { by: string; until?: string | null; soft?: true } | null
  /** Not buyable → the stop bid; low cover → the goal bid × a factor 0.5–1. */
  stock?: { notBuyable: true; stopBidCents: number; by: string } | { coverFactor: number; by: string } | null
  /** Auto-undo restored this campaign: its values are kept, lowering is still allowed. */
  freeze?: { by: string } | null
  /**
   * The playbook phase: a campaign a playbook built and has not started, or a slot the phase floors → the floor; `by`
   * says which (BB-8). (A LAUNCH ramp is the goal's, goal.ts.)
   */
  phase?: { notStarted?: true; floorCents: number; by?: string } | null
  /** The hourly plan's Min-bid hour → its floor. */
  minBidHour?: { floorCents: number } | null
  /**
   * Batch 2 fix — the money brain's brake (cut_bids, and stop_weakest outside the weakest campaigns): every keyword one step
   * down a data day (`stepPct`), from the bid of the day before (not a floor the brain set meanwhile); a goal that asks lower
   * goes lower. Not a floor: nothing is given back when it lifts — the goal walks the bids back up. `by`: whose brake, why.
   */
  money?: { stepPct: number; by: string } | null
  /**
   * BB-17 — the intraday brakes (intraday.ts): the bid steps down from the bid before them (`factor`: the spend cut, a
   * budget's slow hour) and is capped (`capCents`: a CPC spike); given back when they end (`restore`). `by`: the brakes.
   */
  intraday?: { factor?: number; capCents?: number; by: string } | null
}

export interface TargetFacts {
  targetId: string
  currentCents: number
  /** The pooling chain, the target first (estimator.ts). */
  chain: readonly PoolNode[]
  listPriceCents?: number | null
  rootCr?: number
  /** Paid CPC ÷ bid of the ad group, for a target with too few clicks of its own. */
  parentCpcRatio?: number | null
  goal: GoalInputs
  limits: BidLimits
  directives?: readonly Directive[]
  /** BB-9 — the placement rules' caps and floors on the lanes (recipe.ts applyLaneDirectives). */
  laneDirectives?: readonly LaneDirective[]
  /** BB-9 — the goal is a rule's (a GOAL directive): who set it, for the "why". */
  goalBy?: string | null
  /** The hourly plan's lowest serving factor of the day (1 without a plan; BB-7). */
  hourFactor?: number
  /** BB-7 — the campaign's placement lanes this hour, as its hourly plan shapes them (absent: no plan, placements untouched). */
  lanes?: readonly Lane[]
  /** BB-7 — the hourly plan and its hour in words, for the why ("hourly plan IT GALE JACKET: all-out"). */
  planNote?: string | null
  /** BB-18 — the bid that served the window's clicks (absent: today's bid), so r̂ does not follow the bid's own moves. */
  servingCents?: number | null
  /** BB-18 — the most a click can cost against the base bid (recipe.ts stackCeiling); absent: 1. */
  ratioCeiling?: number | null
  /** Pre-go-live — the keyword's saved bid (AdTarget.suppressedFromBidCents): the bid a floor found. */
  savedCents?: number | null
  /** BB-10 — the brain's own raise cap (spend-guard.ts): why a goal raise waits this run; absent: none. */
  raiseCap?: string | null
  /** The newest settled day in the evidence, 'YYYY-MM-DD'. */
  dataDay: string
  /** The brain's last step on this target: the data day it was for, and from → to. */
  lastStep?: { dataDay: string; fromCents: number; toCents: number } | null
  /** Brakes in force, in words ("campaign paused"). Any brake: nothing is decided. */
  brakes?: readonly string[]
  /** Lane 5 — the keyword's target top-of-search impression share and its reading (share.ts). Absent: no target, off. */
  share?: ShareFacts | null
  overrides?: Overrides
  /**
   * BB-8 — the brain's last decision lowered this bid by an override (`layer`, to `heldCents`), or was a give-back that
   * found no bid to go back to (`restore`); `beforeCents` is the bid of its last decision no override lowered (null: none
   * in the decisions kept). Read only when no override applies.
   */
  restore?: { layer: DecisionLayer; heldCents: number; beforeCents: number | null; retryDataDay?: string | null; foundCents?: number | null } | null
}

/** BB-20 — `explore` / `revive`: an explore plan's pick replacing the goal's decision (explore.ts; NEXUS_BID_BRAIN_EXPLORE=on only). */
/** BB-21 — `probe`: a LIVE switchback probe's arm replacing the goal's decision (probe.ts; NEXUS_BID_BRAIN_PROBES=on only). */
/** Lane 5 — `share`: the target top-of-search impression share (share.ts) moved or held the bid. */
export type DecisionLayer = 'brake' | 'stop' | 'pin' | 'stock' | 'freeze' | 'phase' | 'min_bid_hour' | 'money' | 'intraday' | 'restore' | 'goal' | 'band' | 'limit' | 'no_goal' | 'explore' | 'revive' | 'probe' | 'share'

/** BB-9 — a share floor (share of voice, rank, coverage) may reach the bid of this × the band top (design §2). */
export const SHARE_FLOOR_HI_FACTOR = 1.25

/** BB-8 — the override layers that lower a bid and whose end gives the bids back (`restore`). BB-17 — the intraday brakes too. */
export const LOWERING_LAYERS: readonly DecisionLayer[] = ['stop', 'stock', 'phase', 'min_bid_hour', 'intraday']
export type DecisionAction = 'write' | 'hold' | 'brake'

export interface Decision {
  targetId: string
  action: DecisionAction
  layer: DecisionLayer
  currentCents: number
  /** The bid decided (today's bid on a hold or a brake). */
  bidCents: number
  /** What the goal alone asks (after inputs, step and limits); null without a goal or an order value. */
  goalBidCents: number | null
  /** The ACoS expected at today's bid. */
  expectedAcos: number | null
  goal: Pick<Goal, 'aim' | 'lo' | 'hi'> | null
  confidence: number | null
  dataDay: string
  /** The step this decision takes, for the next run's `lastStep` (goal writes only). */
  step: { dataDay: string; fromCents: number; toCents: number } | null
  placements: PlacementDecision[]
  clash: string | null
  /** One line: the deciding layer, the aim, CR̂ with n, the factor and the clamp. */
  why: string
  /** Pre-go-live — a give-back retried on the data day it was refused: the write goes again, its refusal is not logged again. */
  quietRefusal?: boolean
}

const OVERRIDE_ORDER = ['stop', 'pin', 'stock', 'freeze', 'phase', 'minBidHour', 'money', 'intraday'] as const
type OverrideKey = (typeof OVERRIDE_ORDER)[number]
const LAYER_OF: Record<OverrideKey, DecisionLayer> = { stop: 'stop', pin: 'pin', stock: 'stock', freeze: 'freeze', phase: 'phase', minBidHour: 'min_bid_hour', money: 'money', intraday: 'intraday' }

const pct = (f: number) => `${Math.round(f * 1000) / 10}%`
/** A conversion rate needs two decimals: 0.87 %. */
const pct2 = (f: number) => `${Math.round(f * 10_000) / 100}%`
const money = (cents: number) => (cents / 100).toFixed(2)
const n0 = (x: number) => Math.round(x).toLocaleString('en-US')

interface GoalBid {
  cents: number
  goal: Goal
  est: Estimate
  ratio: number
  /** The anchor the step was taken from. */
  anchor: number
  parts: string[]
  clash: string | null
  limitHeld: string | null
  range: ReturnType<typeof limitRange>
  /** BB-9 — the caps a rule's floor and share floor are held to (the band top; hi × 1.25). */
  floorCaps: { floor: number; share: number }
}

/** The recipe for one target, or why there is none. `noStep`: the goal bid itself, inside the limits (a give-back with no bid to start from). */
function goalBid(f: TargetFacts, opts: { noStep?: boolean } = {}): GoalBid | { reason: string } {
  const resolved = resolveGoal(f.goal)
  if (!isGoal(resolved)) return { reason: (resolved as GoalRefusal).reason }
  const goal = resolved
  if (!f.chain.length) return { reason: 'no evidence to pool' }
  const est = estimate(f.chain, { rootCr: f.rootCr, listPriceCents: f.listPriceCents })
  const aov = est.node.aovCents
  if (aov == null || aov <= 0) return { reason: 'no order value known (no sales and no listing price)' }
  const ratio = laneCpcRatio(f.chain[0].evidence, f.servingCents ?? f.currentCents, f.parentCpcRatio, f.ratioCeiling ?? 1)
  const parts: string[] = [`${goalWords(goal)}${f.goalBy ? ` (the goal of ${f.goalBy})` : ''}${goal.notes.length ? `; ${goal.notes.join('; ')}` : ''}`]
  parts.push(`CR ${pct2(est.node.cr)} (${est.basis.level}, ${n0(est.basis.clicks)} clicks) × AOV ${money(aov)} ÷ CPC/bid ${ratio.toFixed(2)}${ratio > 1 ? ' (placements lift the paid CPC above the bid)' : ''}`)

  let want = bidForAcos(goal.aim, est.node.cr, aov, ratio)
  // A new or thin keyword starts at, and stays at, its parent's bid until it earns a raise.
  if (est.parent?.aovCents) {
    const parentCents = bidForAcos(goal.aim, est.parent.cr, est.parent.aovCents, ratio)
    const cap = raiseCap({ wantCents: want, parentCents, node: est.node, aovCents: aov, ratio, hi: goal.hi })
    if (cap.why) parts.push(cap.why)
    want = cap.cents
  }
  const factor = f.hourFactor ?? 1
  if (factor !== 1) {
    want *= factor
    parts.push(`hour factor ×${factor}`)
  }
  // BB-7 — the hour's plan shapes the placements; the keyword bid stays the goal's (the day's lowest serving factor).
  if (f.planNote && f.lanes?.length) parts.push(f.planNote)
  const range = limitRange(f.limits, f.lanes)
  const topBid = bidForAcos(goal.hi, est.node.cr, aov, ratio)
  // BB-9 — a share floor (share of voice, rank) may reach hi × 1.25; the highest bid still holds it below (limits).
  const shareTop = bidForAcos(goal.hi * SHARE_FLOOR_HI_FACTOR, est.node.cr, aov, ratio)
  const dir = applyDirectives(want, f.directives, topBid, shareTop)
  want = dir.cents
  parts.push(...dir.applied, `goal bid ${Math.round(want)}¢`)

  // The step: from the bid before this data day's first step, unless someone else moved the bid since.
  // `>=`: a step recorded for this data day or a newer one (the window moved back) is the day's step (ads-bid-window.ts).
  const sameDay = f.lastStep && f.lastStep.dataDay >= f.dataDay && f.lastStep.toCents === f.currentCents
  const anchor = sameDay ? f.lastStep!.fromCents : f.currentCents
  const maxPct = f.limits.maxChangePct ?? DEFAULT_MAX_CHANGE_PCT
  const stepped = opts.noStep ? { cents: want, held: false } : stepFrom(anchor, want, maxPct, est.confidence)
  if (stepped.held) parts.push(`step ≤${Math.round(maxPct * est.confidence)}% from ${anchor}¢`)
  const clamped = clampToRange(Math.round(stepped.cents), range)
  if (clamped.held) parts.push(`held to ${clamped.held}`)
  return { cents: clamped.cents, goal, est, ratio, anchor, parts, clash: dir.clash, limitHeld: clamped.held, range, floorCaps: { floor: topBid, share: shareTop } }
}

/**
 * BB-10 — the raise cap (a HELD campaign; this hour's spend above 1.5 × its same-hour average): no move above today's bid
 * from any layer — the goal, a limit, a rule's floor, a low-stock factor — except the give-back after the brain's own
 * floor (`restore`). Cuts, stops and floors still go. The decision says what waited and why.
 */
export function decide(f: TargetFacts): Decision {
  const d = decideBid(f)
  // BB-17 — an intraday brake's bid above today's is the give-back after another floor, up to the brake: no raise.
  if (!f.raiseCap || d.action !== 'write' || d.bidCents <= f.currentCents || d.layer === 'restore' || d.layer === 'intraday') return d
  return { ...d, action: 'hold', bidCents: f.currentCents, step: null, why: `${d.layer.replace('_', '-')}: raise held — ${f.raiseCap}; ${f.currentCents}¢ → ${d.bidCents}¢ waits (${d.why})` }
}

function decideBid(f: TargetFacts): Decision {
  const base = {
    targetId: f.targetId,
    currentCents: f.currentCents,
    dataDay: f.dataDay,
    step: null,
    placements: [] as PlacementDecision[],
    clash: null as string | null,
  }
  if (f.brakes?.length) {
    return { ...base, action: 'brake', layer: 'brake', bidCents: f.currentCents, goalBidCents: null, expectedAcos: null, goal: null, confidence: null, why: `brake: ${f.brakes.join('; ')} — nothing written` }
  }

  const g = goalBid(f)
  const ok = 'cents' in g ? g : null
  const expNow = ok ? expectedAcos(f.currentCents, ok.est.node.cr, ok.est.node.aovCents, ok.ratio) : null
  const known = {
    goalBidCents: ok?.cents ?? null,
    expectedAcos: expNow,
    goal: ok ? { aim: ok.goal.aim, lo: ok.goal.lo, hi: ok.goal.hi } : null,
    confidence: ok ? Math.round(ok.est.confidence * 1000) / 1000 : null,
    clash: ok?.clash ?? null,
  }
  // BB-9 — the placement rules' caps and floors shape the plan's lanes first; the lane CPC ceilings still hold them.
  const lanes = applyLaneDirectives(f.lanes, f.laneDirectives)
  const placements = (bid: number) => (ok && lanes.length ? placementsFor(bid, lanes, ok.goal) : [])

  // ── Overrides: the first that applies decides; the lower bid wins, except a pin. ──
  const o = f.overrides ?? {}
  // BB-10 re-review — auto-undo's own pin yields to a floor, and to the give-back after the brain's floor (which lands on
  // the bid before it exactly: the pinned one).
  const floorApplies = (['stop', 'stock', 'phase', 'minBidHour'] as const).some((k) => o[k] != null)
  const r0 = f.restore
  const givingBack = !!r0 && ((LOWERING_LAYERS as readonly string[]).includes(r0.layer) || r0.layer === 'restore') && f.currentCents <= r0.heldCents
  const softPinYields = !!o.pin?.soft && (floorApplies || givingBack)
  const applying = OVERRIDE_ORDER.filter((k) => o[k] != null && !(k === 'pin' && softPinYields))
  if (applying.length) {
    const first = applying[0]
    if (first === 'pin') {
      const pin = o.pin!
      return { ...base, ...known, action: 'hold', layer: 'pin', bidCents: f.currentCents, why: `pin: held by ${pin.by}${pin.until ? ` until ${pin.until}` : ''} — left alone` }
    }
    const bids: Array<{ key: OverrideKey; cents: number; words: string }> = []
    // Batch 2 fix — the money step's base: the bid before this data day's step (a rerun never compounds), else the bid
    // before a floor the brain set (a Min-bid hour is not the base), else today's bid.
    let moneyStep: { dataDay: string; fromCents: number; toCents: number } | null = null
    let yielded: Decision | null = null
    for (const k of applying) {
      if (k === 'stop') bids.push({ key: k, cents: o.stop!.bidCents, words: `stop by ${o.stop!.by} → ${o.stop!.bidCents}¢` })
      else if (k === 'stock') {
        const s = o.stock!
        if ('notBuyable' in s) bids.push({ key: k, cents: s.stopBidCents, words: `not buyable (${s.by}) → ${s.stopBidCents}¢` })
        else if (ok) {
          const factor = Math.min(1, Math.max(0.5, s.coverFactor))
          bids.push({ key: k, cents: Math.max(ok.range.lower, Math.round(ok.cents * factor)), words: `low stock cover (${s.by}) → goal bid ×${factor}` })
        }
      } else if (k === 'freeze') bids.push({ key: k, cents: ok ? Math.min(ok.cents, f.currentCents) : f.currentCents, words: `auto-undo freeze (${o.freeze!.by}): no raise` })
      else if (k === 'phase') bids.push({ key: k, cents: o.phase!.floorCents, words: `${o.phase!.by ?? 'phase not started'} → ${o.phase!.floorCents}¢` })
      else if (k === 'minBidHour') bids.push({ key: k, cents: o.minBidHour!.floorCents, words: `Min-bid hour${f.planNote ? ` (${f.planNote})` : ''} → ${o.minBidHour!.floorCents}¢` })
      else if (k === 'money') {
        const m = o.money!
        const sameDay = !!f.lastStep && f.lastStep.dataDay >= f.dataDay && f.lastStep.toCents === f.currentCents
        const before = givingBack ? r0!.beforeCents ?? [r0!.foundCents, f.savedCents].find((c): c is number => c != null && c > 0) ?? null : null
        const anchor = sameDay ? f.lastStep!.fromCents : before ?? f.currentCents
        const range = ok?.range ?? limitRange(f.limits, f.lanes)
        let cents = clampToRange(Math.round(anchor * (1 - m.stepPct / 100)), range).cents
        // The goal asks lower only where it would move the bid itself: today's bid above the band (an in-band keyword holds).
        const goalLower = !!ok && expNow != null && expNow > ok.goal.hi && ok.cents < cents
        if (goalLower) cents = ok!.cents
        moneyStep = { dataDay: f.dataDay, fromCents: anchor, toCents: cents }
        bids.push({ key: k, cents, words: `${m.by}: bids step down ${m.stepPct} % a day — ${anchor}¢ → ${cents}¢${goalLower ? ' (the goal asks lower)' : ''}${sameDay ? ' (this data day\'s step, taken once)' : ''}` })
      } else if (k === 'intraday') {
        const b = intradayBid(f, o.intraday!)
        if (b && 'cents' in b) bids.push({ key: k, cents: b.cents, words: b.words })
        else if (b && 'goal' in b) yielded = b.goal
      }
    }
    if (bids.length) {
      // BB-17 — a tie goes to the intraday brake, and a decision its bid decides carries its layer: the next run then reads
      // the bid before it from the brain's memory (a freeze or the money step named first would hide it: cut after cut).
      const lowest = bids.reduce((a, b) => (b.cents < a.cents || (b.cents === a.cents && b.key === 'intraday') ? b : a))
      const layer = lowest.key === 'intraday' ? LAYER_OF.intraday : LAYER_OF[bids[0].key]
      const others = bids.filter((b) => b !== lowest).map((b) => b.words)
      const why = `${layer.replace('_', '-')}: ${lowest.words}${others.length ? ` (also: ${others.join('; ')})` : ''}`
      const action: DecisionAction = lowest.cents !== f.currentCents ? 'write' : 'hold'
      return { ...base, ...known, action, layer, bidCents: lowest.cents, placements: placements(lowest.cents), why, ...(lowest.key === 'money' && moneyStep ? { step: moneyStep } : {}) }
    }
    // BB-17 — the goal cuts at least as deep as the intraday brake would: its own decision goes (the brake applies on top
    // of it from the next run, its bid then the bid before).
    if (yielded) return yielded
  }

  // ── BB-8: a stop that lifted gives the bids back. ──
  const r = f.restore
  if (r && ((LOWERING_LAYERS as readonly string[]).includes(r.layer) || r.layer === 'restore') && f.currentCents <= r.heldCents) {
    // `restore`: an earlier give-back found no bid to go back to; it is tried again on every run until it does.
    const lifted = r.layer === 'restore' ? 'restore: the stop that lowered it no longer applies' : `restore: the ${r.layer.replace('_', '-')} layer no longer applies`
    // Pre-go-live — a give-back already refused on this data day is sent again, without logging the refusal again.
    const quiet = r.layer === 'restore' && !!r.retryDataDay && r.retryDataDay >= f.dataDay ? { quietRefusal: true } : {}
    // Pre-go-live — the bid before: the newest decision no override lowered; with none kept (every decision since lowered
    // it), the bid the brain's first floor found, else the bid the floor saved — never "no bid to give back" while one is known.
    const beforeCents = r.beforeCents ?? [r.foundCents, f.savedCents].find((c): c is number => c != null && c > 0) ?? null
    if (beforeCents != null) {
      // As if the stop never happened: today's decision taken from the bid before it. BB-7 review — with the day's step
      // anchor kept when it is for this data day or a newer one (ads-bid-window.ts movedThisDataDay reads `>=` too), so
      // a second Min-bid exit on the same data day lands where the first did and takes no new step (C3's slide).
      const keep = f.lastStep && f.lastStep.dataDay >= f.dataDay ? f.lastStep : null
      const asIf = decide({ ...f, currentCents: beforeCents, lastStep: keep, restore: null, overrides: {}, brakes: [] })
      // BB-7 review — held inside today's limits (the strategy's highest bid, the campaign's bounds, the plan's day ceiling):
      // a between-slots tick has no goal, and the bid before may sit above a limit set since.
      // Under auto-undo's pin: back to the bid the floor found — the pinned one — exactly, no goal step. Pre-go-live — not
      // the bid before: the newest decision no override lowered may be the very change auto-undo put back (an undone raise
      // would be raised again, an undone cut cut again). The bid the brain's first floor found (that floor decision's
      // currentCents), else the bid the floor saved (AdTarget.suppressedFromBidCents; a stop's owner clears it on its lift).
      const found = [r.foundCents, f.savedCents].find((c): c is number => c != null && c > 0)
      const pinned = found ?? beforeCents
      const cents = clampToRange(o.pin?.soft ? pinned : asIf.bidCents, limitRange(f.limits, f.lanes)).cents
      const why = `${lifted} → back to ${cents}¢ from the ${f.currentCents}¢ it held (the bid before it: ${beforeCents}¢; ${asIf.why})`
      return {
        ...base, ...known, ...quiet, action: cents !== f.currentCents ? 'write' : 'hold', layer: 'restore', bidCents: cents,
        step: asIf.step ?? keep ?? { dataDay: f.dataDay, fromCents: beforeCents, toCents: cents }, placements: placements(cents), why,
      }
    }
    const g0 = ok ? goalBid(f, { noStep: true }) : null
    if (g0 && 'cents' in g0) {
      const cents = g0.cents
      return {
        ...base, ...known, ...quiet, action: cents !== f.currentCents ? 'write' : 'hold', layer: 'restore', bidCents: cents,
        step: { dataDay: f.dataDay, fromCents: cents, toCents: cents }, placements: placements(cents),
        why: `${lifted} → the goal bid ${cents}¢ (no bid before it is known; ${g0.parts.join('; ')})`,
      }
    }
    return {
      ...base, ...known, action: 'hold', layer: 'restore', bidCents: f.currentCents,
      why: `${lifted}, but there is no bid to give back (no bid before it is known, and no goal: ${'reason' in g ? g.reason : 'none'}) — it stays at ${f.currentCents}¢ until a target or a bid is set`,
    }
  }

  // ── The goal. ──
  if (!ok) return { ...base, ...known, action: 'hold', layer: 'no_goal', bidCents: f.currentCents, why: `no goal: ${(g as { reason: string }).reason} — left alone` }
  const recipe = ok.parts.join('; ')
  const outside = clampToRange(f.currentCents, ok.range)
  if (outside.held && outside.cents !== f.currentCents) {
    const cents = outside.cents
    return { ...base, ...known, action: 'write', layer: 'limit', bidCents: cents, placements: placements(cents), why: `limit: ${f.currentCents}¢ is outside ${outside.held} → ${cents}¢` }
  }
  // BB-9 — a rule's ceiling or floor binds like a limit: a bid outside it is brought inside it, in the band or not (the
  // rule asked for that bid; today's rule action writes it at once).
  if (f.directives?.length) {
    const ruled = applyDirectives(f.currentCents, f.directives, ok.floorCaps.floor, ok.floorCaps.share)
    const cents = clampToRange(ruled.cents, ok.range).cents
    if (cents !== f.currentCents) {
      return { ...base, ...known, action: 'write', layer: 'limit', bidCents: cents, placements: placements(cents), why: `rule input: ${f.currentCents}¢ is outside the ${ruled.applied.join('; ')} → ${cents}¢ (${recipe})` }
    }
  }
  // Lane 5 — the target top-of-search impression share: after the limits and the rule inputs, before the band.
  let shareNote: string | null = null
  if (f.share) {
    const sh = shareLayer(f, ok, expNow, lanes)
    if ('note' in sh) shareNote = sh.note
    else return { ...base, ...known, ...sh, layer: 'share', placements: placements(sh.bidCents) }
  }
  const noted = (why: string) => (shareNote ? `${why} · ${shareNote}` : why)
  if (expNow != null && expNow >= ok.goal.lo && expNow <= ok.goal.hi) {
    return { ...base, ...known, action: 'hold', layer: 'band', bidCents: f.currentCents, placements: placements(f.currentCents), why: noted(`in band: expected ACoS ${pct(expNow)} at ${f.currentCents}¢ is inside ${pct(ok.goal.lo)}–${pct(ok.goal.hi)} — no change (${recipe})`) }
  }
  const delta = Math.abs(ok.cents - f.currentCents)
  if (delta < MIN_WRITE_CENTS || delta < f.currentCents * MIN_WRITE_SHARE) {
    const already = !!f.lastStep && f.lastStep.dataDay >= f.dataDay && f.lastStep.toCents === f.currentCents
    const why = already ? `goal: already moved for data day ${f.dataDay} — waits for a new day (${recipe})` : `goal: ${recipe}; ${f.currentCents}¢ → ${ok.cents}¢ is too small a change`
    return { ...base, ...known, action: 'hold', layer: 'goal', bidCents: f.currentCents, placements: placements(f.currentCents), why: noted(why) }
  }
  return {
    ...base,
    ...known,
    action: 'write',
    layer: 'goal',
    bidCents: ok.cents,
    step: { dataDay: f.dataDay, fromCents: ok.anchor, toCents: ok.cents },
    placements: placements(ok.cents),
    why: noted(`goal: ${recipe}; ${f.currentCents}¢ → ${ok.cents}¢`),
  }
}

/**
 * Lane 5 — the share layer for one keyword with a target (share.ts): a decision of its own (a move, a hold within the dead
 * zone or at a cap, the wait after its move), or a note for the goal's decision when the band top wins or the reading does
 * not count. Every line names the reading's grain, days, range and impressions (readingWords); never a word for a place.
 */
function shareLayer(f: TargetFacts, ok: GoalBid, expNow: number | null, lanes: readonly Lane[]): { action: DecisionAction; bidCents: number; step: Decision['step']; why: string } | { note: string } {
  const s = f.share!
  const head = `share: target top-of-search impression share ${s.targetPct}% (${s.targetBy})`
  const acos = expNow != null ? `expected ACoS ${pct(expNow)} at ${f.currentCents}¢, band ${pct(ok.goal.lo)}–${pct(ok.goal.hi)}` : `no expected ACoS at ${f.currentCents}¢`
  const read = s.reading ? readingWords(s.reading) : null
  const hold = (why: string) => ({ action: 'hold' as const, bidCents: f.currentCents, step: null, why })
  // The band top wins (D1 = A): an ACoS above it goes to the goal, which lowers — whatever the share says.
  if (expNow != null && expNow > ok.goal.hi) return { note: `${head}: no share move — the band top wins (${acos})${read ? `; ${read}` : ''}` }
  if (s.waiting) return hold(`${head}: ${s.held}${read ? `; ${read}` : ''} — no change (${acos})`)
  if (s.held || !s.reading) return { note: `${head}: no share move — ${s.held ?? 'no reading'}${read ? `; ${read}` : ''}` }
  const caps = [
    { cents: Math.floor(ok.floorCaps.floor), from: `the bid where the expected ACoS meets the band top ${pct(ok.goal.hi)}` },
    ok.range.upper != null ? { cents: ok.range.upper, from: ok.range.upperFrom ?? 'the highest bid' } : null,
    tosLaneCap(lanes),
  ]
  const m = shareMove({ currentCents: f.currentCents, reading: s.reading, targetPct: s.targetPct, maxChangePct: f.limits.maxChangePct ?? DEFAULT_MAX_CHANGE_PCT, caps, floorCents: ok.range.lower })
  const versus = `${read} is ${s.reading.pct < s.targetPct ? 'below' : 'above'} the target by more than 5 points`
  if (m.dir === 'raise') {
    const capWords = m.capped ? ` (held to ${m.capped.from}, ${Math.floor(m.capped.cents)}¢; ${SHARE_NEXT_LEVER})` : ''
    return { action: 'write', bidCents: m.cents, step: { dataDay: f.dataDay, fromCents: f.currentCents, toCents: m.cents }, why: `${head}: ${versus} → raise ≤${m.stepPct}%: ${f.currentCents}¢ → ${m.cents}¢${capWords} (${acos})` }
  }
  if (m.dir === 'lower') {
    return { action: 'write', bidCents: m.cents, step: { dataDay: f.dataDay, fromCents: f.currentCents, toCents: m.cents }, why: `${head}: ${versus} → lower ≤${m.stepPct}%: ${f.currentCents}¢ → ${m.cents}¢${m.cents === ok.range.lower ? ` (held at ${ok.range.lowerFrom})` : ''} (${acos})` }
  }
  if (m.why === 'dead_zone') return hold(`${head}: ${read} is within 5 points of the target — no change (${acos})`)
  if (m.why === 'at_cap') return hold(`${head}: ${versus}, but ${f.currentCents}¢ is at or above its cap (${m.capped?.from}, ${m.capped ? Math.floor(m.capped.cents) : f.currentCents}¢) — no raise; ${SHARE_NEXT_LEVER} (${acos})`)
  if (m.why === 'at_floor') return hold(`${head}: ${versus}, but ${f.currentCents}¢ is at ${ok.range.lowerFrom} — no lower (${acos})`)
  return hold(`${head}: ${versus}, but the strategy's largest change is 0 % — no change (${acos})`)
}

/**
 * BB-17 — the intraday brakes' bid (intraday.ts): `factor` steps the bid down from the bid before the brakes, `capCents`
 * caps it — never below the limits' lowest bid (the strategy's, the campaign's, the 5¢ engine floor), never above the bid
 * before. The bid before: what the brain's last lowering found while the bid still sits at or under it — this brake's own
 * (so a rerun never cuts its own cut again, and a light tick lands where a full run did) or another floor's that just
 * ended (the brake then gives back up to its own bid) — else today's.
 *   null   the brake does not bite (it would not go below the bid before), or another floor just ended and the goal,
 *          decided from the bid before, lands at or below the brake: the goal or the give-back (`restore`) decides
 *   goal   the goal, decided from the bid before, cuts at least as deep: its own decision goes, and the brake applies on
 *          top of it from the next run (its bid then the bid before)
 * So a brake never lands a bid above what the goal or the give-back would decide without it.
 */
function intradayBid(f: TargetFacts, b: NonNullable<Overrides['intraday']>): { cents: number; words: string } | { goal: Decision } | null {
  const r = f.restore
  const lowered = !!r && ((LOWERING_LAYERS as readonly string[]).includes(r.layer) || r.layer === 'restore') && f.currentCents <= r.heldCents
  const before = lowered ? r!.beforeCents ?? [r!.foundCents, f.savedCents].find((c): c is number => c != null && c > 0) ?? f.currentCents : f.currentCents
  let cents = before
  if (b.factor != null && b.factor > 0 && b.factor < 1) cents = Math.floor(before * b.factor)
  if (b.capCents != null && b.capCents > 0) cents = Math.min(cents, b.capCents)
  cents = Math.min(before, Math.max(cents, limitRange(f.limits, f.lanes).lower))
  if (cents >= before) return null
  // What the goal decides from the bid before (as the give-back after a floor does): at or below the brake, it goes.
  const keep = f.lastStep && f.lastStep.dataDay >= f.dataDay ? f.lastStep : null
  const asIf = decideBid({ ...f, currentCents: before, lastStep: keep, restore: null, overrides: {}, brakes: [] })
  if (asIf.action === 'write' && asIf.bidCents <= cents) {
    // After another floor that ended, the give-back itself lands there (the `restore` layer, its memory cleared).
    if (lowered && r!.layer !== 'intraday') return null
    return { goal: { ...asIf, currentCents: f.currentCents, action: asIf.bidCents !== f.currentCents ? 'write' : 'hold', why: `${asIf.why} — at or below ${b.by} (${cents}¢)` } }
  }
  return { cents, words: `${b.by} → ${cents}¢ from the ${before}¢ before it` }
}
