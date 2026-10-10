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
 *              the goal decided from the bid before the stop (one step from it), else that bid, else the goal itself.
 *              Bid-page fix 10-10: a run with no evidence (the 15-minute tick that lifts a floor) gives back the bid a run
 *              with evidence decided while the floor held (`giveBack`, from the same bid before) — the product cycle's bids
 *              run once a data day, inside the plan's night floor; a limit that holds the bid given back is named
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
  ENGINE_FLOOR_CENTS,
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
  /**
   * Owner decision A (10-10) — whose ceiling this hour's lanes carry, in words ("the plan at 14:00–16:00"): the keyword bid
   * is held to THIS hour's ceiling (holdToHour), not the day's lowest.
   */
  hourWords?: string | null
  /**
   * Owner decision A (10-10) — the brain's newest decision held the bid below its own because of the plan's hour: `cents`
   * the bid it left, `fromCents` the bid it found (a write that did not land leaves that one), `beforeCents` the brain's own
   * bid the hour held it from. Read only while the bid sits at one of the two.
   */
  planHeld?: { cents: number; fromCents: number; beforeCents: number } | null
  /** Final review 10-10 — set by decide() when it decides from the brain's own bid: the bid that stands (internal). */
  standingCents?: number | null
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
  restore?: { layer: DecisionLayer; heldCents: number; beforeCents: number | null; retryDataDay?: string | null; foundCents?: number | null; giveBack?: GiveBack | null } | null
}

/**
 * Bid-page fix 10-10 — the give-back a run WITH evidence decided while a floor held the keyword: the bid the goal sets when
 * the floor lifts, decided from the bid before it (one step, inside the limits and the raise caps of that run). A run with
 * no evidence (the 15-minute tick that lands the plan's hours) gives back this bid, when it was decided from the same bid
 * before and for this data day or a newer one; else the bid before itself, as before. Never decided without evidence.
 */
export interface GiveBack {
  dataDay: string
  /** The bid before the floor it was decided from. */
  fromCents: number
  /** The bid to give back. */
  cents: number
  goalBidCents: number | null
  step: { dataDay: string; fromCents: number; toCents: number } | null
  why: string
}

/** A give-back's identity, so a run stores a decision whose give-back changed (shadow.ts rowKind). */
export const giveBackKey = (g: Pick<GiveBack, 'dataDay' | 'fromCents' | 'cents'> | null | undefined): string | null => (g ? `${g.dataDay}|${g.fromCents}|${g.cents}` : null)

/** BB-20 — `explore` / `revive`: an explore plan's pick replacing the goal's decision (explore.ts; NEXUS_BID_BRAIN_EXPLORE=on only). */
/** BB-21 — `probe`: a LIVE switchback probe's arm replacing the goal's decision (probe.ts; NEXUS_BID_BRAIN_PROBES=on only). */
/** Owner decision A (10-10) — `plan_hour`: a move only this hour's plan ceiling makes (down to it, or back up when it rises). */
/** Lane 5 — `share`: the target top-of-search impression share (share.ts) moved or held the bid. */
export type DecisionLayer = 'brake' | 'stop' | 'pin' | 'stock' | 'freeze' | 'phase' | 'min_bid_hour' | 'money' | 'intraday' | 'restore' | 'goal' | 'band' | 'limit' | 'no_goal' | 'explore' | 'revive' | 'probe' | 'share' | 'plan_hour'

/** BB-9 — a share floor (share of voice, rank, coverage) may reach the bid of this × the band top (design §2). */
export const SHARE_FLOOR_HI_FACTOR = 1.25

/** BB-8 — the override layers that lower a bid and whose end gives the bids back (`restore`). BB-17 — the intraday brakes too. */
export const LOWERING_LAYERS: readonly DecisionLayer[] = ['stop', 'stock', 'phase', 'min_bid_hour', 'intraday']
/**
 * The layers whose decided bid no override lowered: the bid a give-back returns to is the newest of these (load.ts
 * loadLowered), and a floor written after the newest of them is the brain's own (enrollment.ts floorsWithoutMemory).
 * BB-20/21 added explore, revive and probe; integration review fix (2026-10-10) — lane 5's share move too: a floor after a
 * share step gives back the share's bid, not the bid before it.
 */
// Bid-page fix 10-10 — the money brake's step down (the newest bid the brain set: a floor after it gives back that bid, not
// the one before the step) and the plan's hour move (Owner decision A) too.
export const UNLOWERED_LAYERS: readonly DecisionLayer[] = ['goal', 'band', 'limit', 'no_goal', 'pin', 'freeze', 'probe', 'explore', 'revive', 'share', 'money', 'plan_hour']
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
  /** Bid-page fix 10-10 — a floor decided with evidence: the bid the goal gives back when it lifts (GiveBack). */
  giveBack?: GiveBack | null
  /** Owner decision A (10-10) — this hour's plan ceiling holds the bid below the brain's own: that bid (planHeld next run). */
  beforeHour?: number | null
  /**
   * Review fix 10-10 (2) — a give-back's bid before it: up to it the write is a give-back (live-writer.ts writeKind
   * `restore`); a give-back above it carries the goal's raise, a forward move (the dial and the caps judge it).
   */
  restoreBeforeCents?: number | null
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
  // Owner decision A (10-10) — the hourly plan's ceiling binds per hour, after the goal (holdToHour): not in its range.
  const range = limitRange(f.limits)
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
  // Owner decision A (10-10) — decided from the brain's own bid (the one before this hour's plan held it), then held to
  // this hour's ceiling (holdToHour); the raise cap below holds a plan raise too (the money brake's hold, a HELD campaign).
  // A give-back that is due (the bid still at a floor) is decided from the bid as it is: the floor's memory decides it.
  const due = !!f.restore && f.currentCents <= f.restore.heldCents
  const own = due ? f.currentCents : ownBidOf(f)
  const d = onlyLowers(holdToHour(decideBid(own !== f.currentCents ? { ...f, currentCents: own, standingCents: f.currentCents } : f), f, own), f, own, due)
  // BB-17 — an intraday brake's bid above today's is the give-back after another floor, up to the brake: no raise.
  if (!f.raiseCap || d.action !== 'write' || d.bidCents <= f.currentCents || d.layer === 'restore' || d.layer === 'intraday') return d
  // Owner decision A — a raise held while the plan's hour holds the bid keeps the brain's own bid in memory (planHeld).
  // Re-review C — never above the own bid it had: a raise that was not written is no bid of the brain's (else each held run
  // would ratchet it a step higher, and the plan would give back a bid past every step limit when the hold lifts).
  const kept = own !== f.currentCents ? { beforeHour: Math.min(own, d.beforeHour ?? d.bidCents) } : {}
  return { ...d, ...kept, action: 'hold', bidCents: f.currentCents, step: null, why: `${d.layer.replace('_', '-')}: raise held — ${f.raiseCap}; ${f.currentCents}¢ → ${d.bidCents}¢ waits (${d.why})` }
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
    // Final review 10-10 (2) — a brake bites from min(the brain's bid, this hour's plan ceiling), as hard as when the bid sat
    // at the plan's ceiling (before the per-hour ceiling); a freeze holds the bid that stands.
    const hourCap = hourCapOf(f)?.cents ?? null
    const underHour = (cents: number) => (hourCap != null ? Math.min(cents, hourCap) : cents)
    const stand = f.standingCents ?? f.currentCents
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
          bids.push({ key: k, cents: Math.max(ok.range.lower, Math.round(underHour(ok.cents) * factor)), words: `low stock cover (${s.by}) → goal bid ×${factor}` })
        } else if (givingBack) {
          // Review fix 10-10 — no goal this run (a tick with no evidence) while a floor lifts: the bid before it × the factor,
          // never the whole bid back. (Mid-day with no evidence the cover waits for a run with one: the bid is not cut again.)
          const factor = Math.min(1, Math.max(0.5, s.coverFactor))
          const before0 = r0!.beforeCents ?? [r0!.foundCents, f.savedCents].find((c): c is number => c != null && c > 0) ?? null
          const before = before0 != null ? underHour(before0) : null
          if (before != null) bids.push({ key: k, cents: Math.max(limitRange(f.limits).lower, Math.round(before * factor)), words: `low stock cover (${s.by}) → the bid before it ${before}¢ ×${factor} (no goal this run)` })
        }
      } else if (k === 'freeze') bids.push({ key: k, cents: ok ? Math.min(ok.cents, stand) : stand, words: `auto-undo freeze (${o.freeze!.by}): no raise` })
      else if (k === 'phase') bids.push({ key: k, cents: o.phase!.floorCents, words: `${o.phase!.by ?? 'phase not started'} → ${o.phase!.floorCents}¢` })
      else if (k === 'minBidHour') bids.push({ key: k, cents: o.minBidHour!.floorCents, words: `Min-bid hour${f.planNote ? ` (${f.planNote})` : ''} → ${o.minBidHour!.floorCents}¢` })
      else if (k === 'money') {
        const m = o.money!
        const sameDay = !!f.lastStep && f.lastStep.dataDay >= f.dataDay && f.lastStep.toCents === f.currentCents
        const before = givingBack ? r0!.beforeCents ?? [r0!.foundCents, f.savedCents].find((c): c is number => c != null && c > 0) ?? null : null
        // From the bid that stands (not the brain's own bid the plan held above it): the step bites where the bid is.
        const anchor = underHour(sameDay ? f.lastStep!.fromCents : before ?? stand)
        const range = ok?.range ?? limitRange(f.limits)
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
      // Bid-page fix 10-10 — a floor decided with evidence also decides what the goal gives back when it lifts: the tick that
      // lifts it reads no evidence (a product cycle's bids run once a day, inside the plan's night floor).
      // Decided from the bid the give-back will start from: the floor's memory (as the restore below reads it), else the bid
      // this floor finds as it lowers it now, else the bid another owner's floor saved — so a rerun on the same facts
      // decides the same give-back.
      const savedBefore = [f.savedCents].find((c): c is number => c != null && c > 0) ?? null
      const memoBefore = givingBack ? r0!.beforeCents ?? [r0!.foundCents, f.savedCents].find((c): c is number => c != null && c > 0) ?? null : lowest.cents < f.currentCents ? f.currentCents : savedBefore
      const giveBack = ok && (LOWERING_LAYERS as readonly string[]).includes(layer) ? giveBackOf(f, memoBefore) : null
      return { ...base, ...known, action, layer, bidCents: lowest.cents, placements: placements(lowest.cents), why, ...(lowest.key === 'money' && moneyStep ? { step: moneyStep } : {}), ...(giveBack ? { giveBack } : {}) }
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
      // Bid-page fix 10-10 — no evidence this run (a between-slots tick): the give-back a run with evidence decided during the
      // floor, from this same bid before and for this data day or a newer one; never one decided from another bid.
      const memo = !ok && r.giveBack && r.giveBack.fromCents === beforeCents && r.giveBack.dataDay >= f.dataDay ? r.giveBack : null
      // Its step lands where the bid lands (a limit of this hour may hold it lower), so the day's step is taken once.
      const asIf = memo
        ? { bidCents: memo.cents, step: memo.step ? { ...memo.step, toCents: clampToRange(memo.cents, limitRange(f.limits)).cents } : null, why: `the goal as the run with evidence decided it during the floor (data day ${memo.dataDay}): ${memo.why}` }
        : decide({ ...f, currentCents: beforeCents, lastStep: keep, restore: null, overrides: {}, brakes: [], planHeld: null, standingCents: null })
      // BB-7 review — held inside today's limits (the strategy's highest bid, the campaign's bounds, the plan's day ceiling):
      // a between-slots tick has no goal, and the bid before may sit above a limit set since.
      // Under auto-undo's pin: back to the bid the floor found — the pinned one — exactly, no goal step. Pre-go-live — not
      // the bid before: the newest decision no override lowered may be the very change auto-undo put back (an undone raise
      // would be raised again, an undone cut cut again). The bid the brain's first floor found (that floor decision's
      // currentCents), else the bid the floor saved (AdTarget.suppressedFromBidCents; a stop's owner clears it on its lift).
      const found = [r.foundCents, f.savedCents].find((c): c is number => c != null && c > 0)
      const pinned = found ?? beforeCents
      const asked = o.pin?.soft ? pinned : asIf.bidCents
      // Review fix 10-10 — this tick's own holds bind the give-back too (the give-back is exempt from the raise cap below):
      // a raise cap (a HELD campaign, auto-undo's hold, the spend guard, the money brake's hold) or an intraday brake gives
      // back at most the bid before it; a rule's ceiling (one set since the run with evidence too) and the intraday CPC cap
      // still bind.
      let wanted = asked
      const holdWords: string[] = []
      // The bid that stood: the bid the floor found (re-review B — the bid before may be the brain's own bid the plan's hour
      // held below, which never stood), else the bid before. Under auto-undo's pin, the pinned one: the same bid.
      const backTo = pinned
      if (f.raiseCap && wanted > backTo) { wanted = backTo; holdWords.push(`no raise above the bid before it: ${f.raiseCap}`) }
      if (o.intraday?.factor != null && o.intraday.factor < 1 && wanted > backTo) { wanted = backTo; holdWords.push(`no raise above the bid before it: ${o.intraday.by}`) }
      for (const c of f.directives ?? []) if (c.kind === 'CEILING' && wanted > c.cents) { wanted = c.cents; holdWords.push(`held to ${c.cents}¢ by ${c.source}`) }
      if (o.intraday?.capCents != null && o.intraday.capCents > 0 && wanted > o.intraday.capCents) { wanted = o.intraday.capCents; holdWords.push(`held to ${wanted}¢ by ${o.intraday.by}`) }
      const holdStep = wanted !== asked ? { dataDay: f.dataDay, fromCents: backTo, toCents: wanted } : null
      // Held below the brain's own bid by a raise cap: its own bid stays in memory (never above it: re-review C), so the plan
      // gives it back when the hold lifts.
      const innerOwn = (asIf as { beforeHour?: number | null }).beforeHour ?? null
      const ownMemo = holdWords.length && Math.min(asked, beforeCents) > wanted
        ? { beforeHour: Math.min(innerOwn ?? asked, beforeCents) }
        // Final review 10-10 (3) — the give-back decided with the hour's lanes: the goal's own bid the hour held it below.
        : innerOwn != null && innerOwn > wanted ? { beforeHour: innerOwn } : {}
      const held = clampToRange(wanted, limitRange(f.limits))
      const cents = held.cents
      // Bid-page fix 10-10 — a limit that holds the bid given back is said (it was silent: "the bid before it: 20¢", back to 12¢).
      const limitWords = held.held && cents !== wanted ? `; ${wanted}¢ held to ${held.held}` : ''
      const heldBy = holdWords.length ? `; ${asked}¢ ${holdWords.join('; ')}` : ''
      const why = `${lifted} → back to ${cents}¢ from the ${f.currentCents}¢ it held (the bid before it: ${beforeCents}¢${heldBy}${limitWords}; ${asIf.why})`
      return {
        ...base, ...known, ...(memo ? { goalBidCents: memo.goalBidCents } : {}), ...quiet, action: cents !== f.currentCents ? 'write' : 'hold', layer: 'restore', bidCents: cents,
        step: holdStep ?? asIf.step ?? keep ?? { dataDay: f.dataDay, fromCents: beforeCents, toCents: cents }, placements: placements(cents), why,
        restoreBeforeCents: backTo, ...ownMemo,
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
 * Owner decision A (10-10) — this hour's plan ceiling for the keyword bid: the lowest of the hour's lanes' CPC ceilings ÷
 * Amazon's dynamic bidding on the lane (recipe.ts limitRange's lane part). Null with no lane ceiling this hour.
 */
export function hourCapOf(f: Pick<TargetFacts, 'lanes' | 'hourWords'>): { cents: number; words: string } | null {
  const upper = limitRange({}, f.lanes ?? []).upper
  return upper != null ? { cents: upper, words: f.hourWords ?? 'the hourly plan\'s ceiling this hour' } : null
}

/** Owner decision A (10-10) — the brain's own bid: the one before the plan's hour held it, while the bid sits where that left it. */
export function ownBidOf(f: Pick<TargetFacts, 'currentCents' | 'planHeld'>): number {
  const h = f.planHeld
  return h && (f.currentCents === h.cents || f.currentCents === h.fromCents) && h.beforeCents > 0 ? h.beforeCents : f.currentCents
}


/**
 * Owner decision A (10-10) — the hourly plan's CPC ceiling binds PER HOUR. The decision is taken from the brain's own bid
 * (`own`: the one before this hour held it, ownBidOf) inside every other limit; then its bid is held to this hour's
 * ceiling: min(the brain's bid, this hour's ceiling). At an hour boundary the bid follows the hour — down when the ceiling
 * drops, back up to the brain's own bid when it rises — never above that bid, so never above the goal, the Owner's caps,
 * the highest bid or the money brake (each already holds the brain's bid; the raise cap holds a plan raise as any other);
 * a brake and a pin (a person's own edit) are left as decided; every other bid is held to the hour — low stock cover too
 * (re-review A) — and the ceiling never raises one (a floor below it stays the floor: the night's too).
 *
 *   plan's moves   a move only the hour makes (`plan_hour`) takes no goal step: the goal's step and its anchor (lastStep)
 *                  stay the brain's own bid, so the day's step is never used up by the hour and the bid never sticks
 *                  low after a swing. The dead zone holds (no write under 2¢ or 5 %); the write gate judges each write.
 *   extra writes   at most one bid write per keyword per hour boundary where min(its own bid, the ceiling) changes: for a
 *                  day whose serving hours climb and fall through N distinct ceilings once, at most 2·(N−1) writes per
 *                  keyword (0 for a keyword whose own bid is at or below every ceiling of the day); with the day's
 *                  lowest ceiling (before) it was 0.
 */
function holdToHour(d: Decision, f: TargetFacts, own: number): Decision {
  const real = f.currentCents
  if (d.layer === 'brake' || d.layer === 'pin') return own === real ? d : { ...d, currentCents: real, bidCents: real }
  const cap = hourCapOf(f)
  const want = d.bidCents
  // Re-review A — only a brake and a pin pass the hour (above); the ceiling only ever lowers (never under the 5¢ engine
  // floor, never above the bid decided).
  const bid = cap && want > cap.cents ? Math.min(want, Math.max(cap.cents, ENGINE_FLOOR_CENTS)) : want
  const held = bid < want
  const heldWords = held ? `held to ${bid}¢ by ${cap!.words}` : ''
  const lanes = applyLaneDirectives(f.lanes, f.laneDirectives)
  const placed = d.placements.length && d.goal && lanes.length && bid !== want ? { placements: placementsFor(bid, lanes, d.goal) } : {}
  // The brain's own bid is remembered for its own moves; a floor's (stop, stock, phase, Min-bid hour, intraday) is in the
  // floor's memory (the give-back), not here.
  const memo = held && !(LOWERING_LAYERS as readonly string[]).includes(d.layer) ? { beforeHour: Math.max(want, d.beforeHour ?? want) } : {}
  if (own === real && !held) return d
  // Final review 10-10 (1) — an override in force (a freeze, the money brake, low stock cover, an intraday brake, a stop …),
  // even one that set no bid this run: nothing lifts the bid that stands; the brain's own bid stays in memory.
  const o = f.overrides ?? {}
  const anyHold = (['stop', 'stock', 'freeze', 'phase', 'minBidHour', 'money', 'intraday'] as const).some((k) => o[k] != null)
  if (own !== real && anyHold && bid > real) {
    return { ...d, ...placed, ...(own > real ? { beforeHour: own } : {}), currentCents: real, bidCents: real, action: 'hold', step: d.layer === 'goal' || d.layer === 'restore' ? d.step : null, why: `${d.why}; held at ${real}¢ while ${d.layer === 'no_goal' || d.layer === 'goal' || d.layer === 'band' ? 'an override is in force' : `the ${d.layer.replace('_', '-')} layer holds it`}` }
  }
  // A decision that leaves the brain's own bid (a hold at it): any move is the hour's own — the plan's move, in the dead zone.
  // Final review 10-10 (1) — only when no override, hold or brake applies: an override's hold (a freeze, the money brake
  // after its step, low stock cover) never becomes the plan's raise (onlyLowers keeps it at or below the bid that stands).
  if (d.action === 'hold' && want === own && !OVERRIDE_LAYERS.has(d.layer)) {
    const delta = Math.abs(bid - real)
    // Re-review minor — the dead zone holds small raises only: a ceiling below the bid always pulls it down.
    if (bid === real || (bid > real && (delta < MIN_WRITE_CENTS || delta < real * MIN_WRITE_SHARE))) {
      return { ...d, ...placed, ...memo, currentCents: real, bidCents: real, action: 'hold', why: held ? `${d.why}; ${want}¢ ${heldWords}` : d.why }
    }
    const why = bid < real
      ? `plan hour: ${heldWords} (the brain's own bid ${own}¢) — ${real}¢ → ${bid}¢`
      : `plan hour: ${cap ? `${cap.words} allows ${cap.cents}¢` : 'no plan ceiling this hour'} — back to ${held ? `${bid}¢, ${heldWords}` : `the brain's own bid ${bid}¢`}; ${real}¢ → ${bid}¢`
    return { ...d, ...placed, ...memo, currentCents: real, bidCents: bid, action: 'write', layer: 'plan_hour', why }
  }
  // The brain's own move (the goal, a limit, a give-back, the money brake …) held to the hour.
  return { ...d, ...placed, ...memo, currentCents: real, bidCents: bid, action: bid !== real ? 'write' : 'hold', why: held ? `${d.why}; ${want}¢ ${heldWords}` : d.why }
}

/** Final review 10-10 — the override layers: each holds or lowers; none lifts the bid that stands (onlyLowers). */
const OVERRIDE_LAYERS: ReadonlySet<string> = new Set(['stop', 'stock', 'freeze', 'phase', 'min_bid_hour', 'money', 'intraday'])

/**
 * Re-review D — an intraday brake (and the money brake's step down) only lowers: it is decided from the brain's own bid (the
 * one before the plan's hour held it), so on a bid the plan holds lower it could ask a raise (own 16¢ × 0.9 = 14¢ over the 12¢ that stands). It never goes
 * above the bid that stands — after another floor, the bid that stood before it (the floor found it) — and the brain's own
 * bid stays in memory.
 */
function onlyLowers(d: Decision, f: TargetFacts, own: number, due: boolean): Decision {
  // The money brake's step down is a brake too, and so is every override (final review 10-10 (1)): decided from the brain's
  // own bid, none may lift the bid that stands.
  if (!OVERRIDE_LAYERS.has(d.layer)) return d
  // With no plan ceiling this hour and no plan hold in memory: as before the per-hour ceiling — except a brake's give-back
  // after a floor, which may start from the brain's own bid (the bid before it) and so is held to the bid that stood. Under
  // a plan, an override never lifts the bid that stands: the higher hour may give the own bid back only when nothing holds
  // (low stock cover at a 40¢ hour would otherwise lift 11¢ → 13¢, above the day's lowest ceiling it held to before).
  if (own === f.currentCents && hourCapOf(f) == null && !(due && (d.layer === 'intraday' || d.layer === 'money' || d.layer === 'stock'))) return d
  const r = f.restore
  const stood = due && r ? [r.foundCents, f.savedCents, r.beforeCents].find((c): c is number => c != null && c > 0) ?? f.currentCents : f.currentCents
  if (d.bidCents <= stood) return d
  const bid = stood
  const memo = own > bid ? { beforeHour: Math.min(own, d.beforeHour ?? own) } : {}
  // A step not written is no step (the next run takes it from the bid that stands).
  const who = d.layer === 'money' ? 'the money brake' : d.layer === 'intraday' ? 'an intraday brake' : `the ${d.layer.replace('_', '-')} layer`
  return { ...d, ...memo, bidCents: bid, action: bid !== f.currentCents ? 'write' : 'hold', step: null, why: `${d.why}; ${who} only lowers: ${due ? `back to the ${bid}¢ that stood` : `held at ${bid}¢`}` }
}

/**
 * Bid-page fix 10-10 — the give-back after a floor, decided while the floor holds by a run with evidence: the restore's own
 * "as if the stop never happened" (the goal from the bid before, the day's step kept, inside the limits and the raise cap)
 * with the floor's hour taken out (its plan words and 0 % lanes: the hour that lifts it holds the bid to its own limits).
 * Null with no bid before, or no goal from it.
 */
function giveBackOf(f: TargetFacts, beforeCents: number | null): GiveBack | null {
  if (beforeCents == null || beforeCents <= 0) return null
  const keep = f.lastStep && f.lastStep.dataDay >= f.dataDay ? f.lastStep : null
  // Final review 10-10 (3) — with the hour's lanes (the share layer's top-of-search lane cap reads them).
  const asIf = decide({ ...f, currentCents: beforeCents, lastStep: keep, restore: null, overrides: {}, brakes: [], planNote: null, planHeld: null, standingCents: null })
  if (asIf.layer === 'no_goal') return null
  return { dataDay: f.dataDay, fromCents: beforeCents, cents: asIf.bidCents, goalBidCents: asIf.goalBidCents, step: asIf.step, why: asIf.why }
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
  const before0 = lowered ? r!.beforeCents ?? [r!.foundCents, f.savedCents].find((c): c is number => c != null && c > 0) ?? f.currentCents : f.currentCents
  // Final review 10-10 (2) — the brake bites from min(the bid before, this hour's plan ceiling) — and, on a first bite, from
  // the bid that stands (not the brain's own bid the plan held above it).
  const cap = hourCapOf(f)?.cents ?? null
  const standing = lowered ? before0 : Math.min(before0, f.standingCents ?? before0)
  const before = cap != null ? Math.min(standing, cap) : standing
  let cents = before
  if (b.factor != null && b.factor > 0 && b.factor < 1) cents = Math.floor(before * b.factor)
  if (b.capCents != null && b.capCents > 0) cents = Math.min(cents, b.capCents)
  cents = Math.min(before, Math.max(cents, limitRange(f.limits).lower))
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
