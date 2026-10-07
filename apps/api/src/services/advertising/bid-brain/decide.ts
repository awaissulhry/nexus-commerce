/**
 * BID BRAIN BB-1 — `decide(facts) → Decision`: the one place a keyword bid is decided, with its one-line "why".
 *
 *   brakes     first of all: the kill switch, a halt, the dial OFF, the breaker, data older than 48 hours, a paused or
 *              not-allowlisted campaign — nothing is written, and the reason is said
 *   overrides  the first that applies decides, in this fixed order:
 *                STOP ▸ PIN/HOLD ▸ STOCK/RETAIL ▸ AUTO-UNDO FREEZE ▸ PHASE ▸ MIN-BID HOUR
 *              when several apply the lower bid wins, except a pin (left alone, unless a stop comes first)
 *   goal       otherwise the recipe (recipe.ts) from the pooled estimate (estimator.ts) and the goal (goal.ts); it writes
 *              only when the expected ACoS at today's bid is outside the band and the bid moves by ≥ 2¢ and ≥ 5 %, and a
 *              bid outside a hard limit is always brought back inside it
 *
 * Idempotent: the same facts give the same decision. The step is taken from the bid before the brain's first step on
 * the newest data day (`lastStep`), so a rerun on unchanged evidence never compounds (C3: 33→25→19→14¢ in six hours).
 * Pure: no database, no clock.
 */
import { cpcRatio, estimate, type Estimate, type PoolNode } from './estimator.js'
import { goalWords, isGoal, resolveGoal, type Goal, type GoalInputs, type GoalRefusal } from './goal.js'
import {
  applyDirectives,
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
  type PlacementDecision,
} from './recipe.js'

/** The overrides in force for one target. Each is absent when it does not apply. */
export interface Overrides {
  /** suppress-campaign, a monthly cap reached, a playbook STOP: the stop bid. */
  stop?: { bidCents: number; by: string } | null
  /** pinBids, a person's own bid, a Claude request a person approved: left alone until `until`. */
  pin?: { by: string; until?: string | null } | null
  /** Not buyable → the stop bid; low cover → the goal bid × a factor 0.5–1. */
  stock?: { notBuyable: true; stopBidCents: number; by: string } | { coverFactor: number; by: string } | null
  /** Auto-undo restored this campaign: its values are kept, lowering is still allowed. */
  freeze?: { by: string } | null
  /** The playbook phase: not started → the floor. (A LAUNCH ramp is the goal's, goal.ts.) */
  phase?: { notStarted: true; floorCents: number } | null
  /** The hourly plan's Min-bid hour → its floor. */
  minBidHour?: { floorCents: number } | null
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
  /** The hourly plan's lowest serving factor of the day (1 without a plan; BB-7). */
  hourFactor?: number
  lanes?: readonly Lane[]
  /** The newest settled day in the evidence, 'YYYY-MM-DD'. */
  dataDay: string
  /** The brain's last step on this target: the data day it was for, and from → to. */
  lastStep?: { dataDay: string; fromCents: number; toCents: number } | null
  /** Brakes in force, in words ("campaign paused"). Any brake: nothing is decided. */
  brakes?: readonly string[]
  overrides?: Overrides
}

export type DecisionLayer = 'brake' | 'stop' | 'pin' | 'stock' | 'freeze' | 'phase' | 'min_bid_hour' | 'goal' | 'band' | 'limit' | 'no_goal'
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
}

const OVERRIDE_ORDER = ['stop', 'pin', 'stock', 'freeze', 'phase', 'minBidHour'] as const
type OverrideKey = (typeof OVERRIDE_ORDER)[number]
const LAYER_OF: Record<OverrideKey, DecisionLayer> = { stop: 'stop', pin: 'pin', stock: 'stock', freeze: 'freeze', phase: 'phase', minBidHour: 'min_bid_hour' }

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
}

/** The recipe for one target, or why there is none. */
function goalBid(f: TargetFacts): GoalBid | { reason: string } {
  const resolved = resolveGoal(f.goal)
  if (!isGoal(resolved)) return { reason: (resolved as GoalRefusal).reason }
  const goal = resolved
  if (!f.chain.length) return { reason: 'no evidence to pool' }
  const est = estimate(f.chain, { rootCr: f.rootCr, listPriceCents: f.listPriceCents })
  const aov = est.node.aovCents
  if (aov == null || aov <= 0) return { reason: 'no order value known (no sales and no listing price)' }
  const ratio = cpcRatio(f.chain[0].evidence, f.currentCents, f.parentCpcRatio)
  const parts: string[] = [`${goalWords(goal)}${goal.notes.length ? `; ${goal.notes.join('; ')}` : ''}`]
  parts.push(`CR ${pct2(est.node.cr)} (${est.basis.level}, ${n0(est.basis.clicks)} clicks) × AOV ${money(aov)} ÷ CPC/bid ${ratio.toFixed(2)}`)

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
  const range = limitRange(f.limits, f.lanes)
  const topBid = bidForAcos(goal.hi, est.node.cr, aov, ratio)
  const dir = applyDirectives(want, f.directives, topBid)
  want = dir.cents
  parts.push(...dir.applied, `goal bid ${Math.round(want)}¢`)

  // The step: from the bid before this data day's first step, unless someone else moved the bid since.
  const sameDay = f.lastStep && f.lastStep.dataDay === f.dataDay && f.lastStep.toCents === f.currentCents
  const anchor = sameDay ? f.lastStep!.fromCents : f.currentCents
  const maxPct = f.limits.maxChangePct ?? DEFAULT_MAX_CHANGE_PCT
  const stepped = stepFrom(anchor, want, maxPct, est.confidence)
  if (stepped.held) parts.push(`step ≤${Math.round(maxPct * est.confidence)}% from ${anchor}¢`)
  const clamped = clampToRange(Math.round(stepped.cents), range)
  if (clamped.held) parts.push(`held to ${clamped.held}`)
  return { cents: clamped.cents, goal, est, ratio, anchor, parts, clash: dir.clash, limitHeld: clamped.held, range }
}

export function decide(f: TargetFacts): Decision {
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
  const placements = (bid: number) => (ok && f.lanes?.length ? placementsFor(bid, f.lanes, ok.goal) : [])

  // ── Overrides: the first that applies decides; the lower bid wins, except a pin. ──
  const o = f.overrides ?? {}
  const applying = OVERRIDE_ORDER.filter((k) => o[k] != null)
  if (applying.length) {
    const first = applying[0]
    if (first === 'pin') {
      const pin = o.pin!
      return { ...base, ...known, action: 'hold', layer: 'pin', bidCents: f.currentCents, why: `pin: held by ${pin.by}${pin.until ? ` until ${pin.until}` : ''} — left alone` }
    }
    const bids: Array<{ key: OverrideKey; cents: number; words: string }> = []
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
      else if (k === 'phase') bids.push({ key: k, cents: o.phase!.floorCents, words: `phase not started → ${o.phase!.floorCents}¢` })
      else if (k === 'minBidHour') bids.push({ key: k, cents: o.minBidHour!.floorCents, words: `Min-bid hour → ${o.minBidHour!.floorCents}¢` })
    }
    if (bids.length) {
      const lowest = bids.reduce((a, b) => (b.cents < a.cents ? b : a))
      const layer = LAYER_OF[bids[0].key]
      const others = bids.filter((b) => b !== lowest).map((b) => b.words)
      const why = `${layer.replace('_', '-')}: ${lowest.words}${others.length ? ` (also: ${others.join('; ')})` : ''}`
      const action: DecisionAction = lowest.cents !== f.currentCents ? 'write' : 'hold'
      return { ...base, ...known, action, layer, bidCents: lowest.cents, placements: placements(lowest.cents), why }
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
  if (expNow != null && expNow >= ok.goal.lo && expNow <= ok.goal.hi) {
    return { ...base, ...known, action: 'hold', layer: 'band', bidCents: f.currentCents, placements: placements(f.currentCents), why: `in band: expected ACoS ${pct(expNow)} at ${f.currentCents}¢ is inside ${pct(ok.goal.lo)}–${pct(ok.goal.hi)} — no change (${recipe})` }
  }
  const delta = Math.abs(ok.cents - f.currentCents)
  if (delta < MIN_WRITE_CENTS || delta < f.currentCents * MIN_WRITE_SHARE) {
    const already = f.lastStep?.dataDay === f.dataDay && f.lastStep.toCents === f.currentCents
    const why = already ? `goal: already moved for data day ${f.dataDay} — waits for a new day (${recipe})` : `goal: ${recipe}; ${f.currentCents}¢ → ${ok.cents}¢ is too small a change`
    return { ...base, ...known, action: 'hold', layer: 'goal', bidCents: f.currentCents, placements: placements(f.currentCents), why }
  }
  return {
    ...base,
    ...known,
    action: 'write',
    layer: 'goal',
    bidCents: ok.cents,
    step: { dataDay: f.dataDay, fromCents: ok.anchor, toCents: ok.cents },
    placements: placements(ok.cents),
    why: `goal: ${recipe}; ${f.currentCents}¢ → ${ok.cents}¢`,
  }
}
