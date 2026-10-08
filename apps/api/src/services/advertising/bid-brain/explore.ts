/**
 * BID BRAIN BB-20 (design BRAIN-UPGRADES-DESIGN.md U3; the Owner's pick U3-D1 = A) — exploration and revive, inside a small
 * explore budget per market and day. SHADOW FIRST.
 *
 *   explore   once per data day, for a THIN keyword (its own clicks are under half of its estimate: c ÷ (c + K) < 0.5), a
 *             conversion rate is drawn from its Beta posterior, Beta(CR̂ · (c + K), (1 − CR̂) · (c + K)), with a seed made of
 *             the keyword and the data day — the same facts give the same draw, so a rerun lands on the same bid (decide's
 *             promise). Explore bid = the aim's bid at the drawn rate, held inside [0.85 × the goal's bid, the lowest of
 *             1.35 × the goal's bid, the band top's bid, the break-even bid], one step of the strategy's largest change
 *             from the day's anchor, and the limits
 *   revive    a keyword that sold (≥ 1 order in 90 settled days) and went silent (impressions of the last 14 days under 10 %
 *             of its 90-day daily average), or one cut to the floor long ago (its bid within 25 % of the lowest it may
 *             have, no bid write for 30 days) and silent: one step of the strategy's largest change up from the bid it
 *             started at, toward the higher of its goal's and its parent's goal bid; a second step 3 days later; 3 days
 *             after that, still silent → "silent", and no new re-test until 28 days after the first step (the decisions
 *             that remember it are kept 30 days). Impressions are read to yesterday: they do not wait for attribution
 *   never     a keyword an override decides (stop, pin, stock, freeze, phase, Min-bid hour), a give-back, a brake, a raise
 *             cap (a HELD campaign, the spend guard, a product cycle's hold), a rule's ceiling or floor, a product with
 *             under 14 days of stock cover, a keyword with no goal
 *   budget    per market and day: the market row of the ads strategy (`exploreBudgetCents`; 0 = off), else the Owner's
 *             pick — 200¢ in IT, 100¢ in DE, none elsewhere. A pick's expected extra spend is
 *                r̂ · (clicks(b) · b − clicks(g) · g),   clicks(b) = c₀ · (b ÷ today's bid)^ε,  c₀ ≥ 1 click a day
 *             (ε from the response, BB-19; g the goal's bid, or today's for a revive). Revives first, then thin keywords by
 *             the largest posterior sd × traffic; one that does not fit is left out. The picks never add up past the budget
 *
 *   NEXUS_BID_BRAIN_EXPLORE = off · shadow (default) · on
 *     off     nothing is read or said
 *     shadow  the plan is made and logged (the stored why: "explore (shadow): would bid …", `evidence.explore` /
 *             `evidence.revive`); every decision, write and step stays the goal's, byte for byte
 *     on      the picked keywords' decisions become layer `explore` / `revive` (written for a campaign the brain owns, like
 *             any of its decisions); the rest stay the goal's
 *
 * Pure: no database, no clock. The loaders are response-explore.ts.
 */
import type { Decision, TargetFacts } from './decide.js'
import { type NodeEstimate } from './estimator.js'
import { applyLaneDirectives, bidForAcos, clampToRange, placementsFor } from './recipe.js'
import { goalContext, type GoalContext } from './response.js'

export type ExploreMode = 'off' | 'shadow' | 'on'

/** The switch. Anything unrecognised is shadow: decisions never change by accident. */
export function exploreMode(env: string | undefined = process.env.NEXUS_BID_BRAIN_EXPLORE): ExploreMode {
  const v = (env ?? '').trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false') return 'off'
  if (v === 'on' || v === '1' || v === 'true') return 'on'
  return 'shadow'
}

/** U3-D1 (the Owner's pick): 200¢ a day in IT and 100¢ in DE, none elsewhere — until the market row of the strategy sets one. */
export const DEFAULT_EXPLORE_BUDGET_CENTS: Readonly<Record<string, number>> = Object.freeze({ IT: 200, DE: 100 })

/** The market's explore budget a day: the strategy's market row, else the Owner's default (0: off). */
export function exploreBudgetOf(market: string, strategyCents: number | null | undefined): { cents: number; from: 'strategy' | 'default' } {
  if (typeof strategyCents === 'number' && Number.isFinite(strategyCents) && strategyCents >= 0) return { cents: Math.floor(strategyCents), from: 'strategy' }
  return { cents: DEFAULT_EXPLORE_BUDGET_CENTS[market] ?? 0, from: 'default' }
}

export const THIN_CONFIDENCE = 0.5
export const EXPLORE_LOW_SHARE = 0.85
export const EXPLORE_HIGH_SHARE = 1.35
/** A pick's traffic is never read as under one click a day (a thin keyword's own rate says little). */
export const MIN_CLICKS_PER_DAY = 1
export const REVIVE_SILENT_SHARE = 0.1
export const REVIVE_QUIET_DAYS = 14
export const REVIVE_STEP_DAYS = 3
export const REVIVE_MAX_STEPS = 2
export const REVIVE_REST_DAYS = 28
export const REVIVE_MIN_ORDERS = 1
/** "Cut to the floor": the bid within this multiple of the lowest it may have, and no bid write for this many days. */
export const FLOOR_BAND = 1.25
export const FLOOR_LONG_AGO_DAYS = 30
export const MIN_COVER_DAYS = 14
/** The ε a pick's traffic is scaled with when the response is off (the prior's mean, BB-19). */
export const DEFAULT_EPS = 0.8

// ── The seeded draw ───────────────────────────────────────────────────────────────────────────────

/** FNV-1a, 32 bits: the seed of a key ("targetId|dataDay"). */
export function seedOf(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** mulberry32: a small deterministic generator in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A standard normal (Box–Muller). */
function normal(rng: () => number): number {
  const u = 1 - rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** A Gamma(shape, 1) draw (Marsaglia–Tsang; shape < 1 boosted). */
export function gammaDraw(shape: number, rng: () => number): number {
  if (shape < 1) return gammaDraw(shape + 1, rng) * Math.pow(1 - rng(), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do { x = normal(rng); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = 1 - rng()
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

/** A Beta(a, b) draw. */
export function betaDraw(a: number, b: number, rng: () => number): number {
  const x = gammaDraw(a, rng)
  const y = gammaDraw(b, rng)
  return x + y > 0 ? x / (x + y) : a / (a + b)
}

/** The node's Beta posterior: Beta(CR̂ · (c + K), (1 − CR̂) · (c + K)) — the one crLowerBound80 reads. */
const posteriorOf = (n: Pick<NodeEstimate, 'cr' | 'k' | 'clicks'>) => {
  const total = Math.max(1e-6, n.clicks + n.k)
  return { a: Math.max(1e-6, n.cr * total), b: Math.max(1e-6, (1 - n.cr) * total), total }
}

/** Thompson sampling: a conversion rate drawn from the node's posterior with a seeded generator (same key, same rate). */
export function thompsonCr(node: Pick<NodeEstimate, 'cr' | 'k' | 'clicks'>, key: string): number {
  const { a, b } = posteriorOf(node)
  return betaDraw(a, b, mulberry32(seedOf(key)))
}

/** The posterior sd of the node's conversion rate. */
export function crSd(node: Pick<NodeEstimate, 'cr' | 'k' | 'clicks'>): number {
  const { a, b, total } = posteriorOf(node)
  return Math.sqrt((a * b) / (total * total * (total + 1)))
}

/** The node's own share of its estimate: c ÷ (c + K). */
export const ownShare = (n: Pick<NodeEstimate, 'k' | 'clicks'>): number => (n.clicks + n.k > 0 ? n.clicks / (n.clicks + n.k) : 0)

// ── What the loaders bring per keyword ────────────────────────────────────────────────────────────

/** One keyword's activity and memory, as the loader reads them. */
export interface TargetActivity {
  /** Impressions of the last 14 days (to yesterday) and the 90 days to yesterday, raw. */
  impressions14: number
  impressions90: number
  /** Clicks of the last 14 days to yesterday, raw (traffic). */
  clicks14: number
  /** Orders over the 90 settled days, raw. */
  orders90: number
  /** The shortest stock cover in days of the products its ad group advertises; null: not known. */
  coverDays?: number | null
  /** Days since the keyword's newest bid write; null: none in the 30 days read. */
  daysSinceWrite?: number | null
  /** The revive memory: the newest one the brain stored for it (evidence.revive), if any in the decisions kept. */
  revive?: ReviveMemory | null
}

/** What a stored decision remembers of a revive: the day it began, the bid it began from, its step or state then. */
export interface ReviveMemory {
  start: string
  fromCents: number
  step: number
  state: 'step' | 'silent'
  dataDay: string
}

const DAY_MS = 86_400_000
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** The revive schedule on a data day: a new re-test, step 1 or 2 (3 days apart), silent after both, at rest for 28 days. */
export function reviveStage(memory: ReviveMemory | null | undefined, dataDay: string, currentCents: number): { state: 'step'; step: number; start: string; fromCents: number } | { state: 'silent' | 'rest'; start: string; until: string } {
  if (!memory || daysBetween(memory.start, dataDay) >= REVIVE_REST_DAYS || daysBetween(memory.start, dataDay) < 0) {
    return { state: 'step', step: 1, start: dataDay, fromCents: currentCents }
  }
  const age = daysBetween(memory.start, dataDay)
  const until = addDays(memory.start, REVIVE_REST_DAYS)
  if (age < REVIVE_STEP_DAYS * REVIVE_MAX_STEPS) return { state: 'step', step: Math.floor(age / REVIVE_STEP_DAYS) + 1, start: memory.start, fromCents: memory.fromCents }
  return { state: age < REVIVE_STEP_DAYS * (REVIVE_MAX_STEPS + 1) ? 'silent' : 'rest', start: memory.start, until }
}

// ── One keyword ───────────────────────────────────────────────────────────────────────────────────

export type PickKind = 'explore' | 'revive'

/** A keyword the plan may pick: its bid, the bid it replaces, its expected extra spend a day, its priority, its words. */
export interface ExploreOption {
  targetId: string
  kind: PickKind
  bidCents: number
  /** The goal's bid it stands beside (a revive: the goal's bid too). */
  goalBidCents: number
  /** Expected extra spend a day against the goal's bid (≥ 0, cents, unrounded). */
  extraCents: number
  priority: number
  /** The anchor of the day's step (decide.ts), for the step a write records. */
  anchorCents: number
  words: string
  draw?: number
  revive?: ReviveMemory
}

/** Why a keyword is not an option; a revive at rest keeps its memory, and says so (`say`) in the 3 days it turns silent. */
export interface ExploreSkip { targetId: string; why: string; revive?: ReviveMemory; say?: true }

const pct2 = (f: number) => `${Math.round(f * 10_000) / 100}%`
const pct0 = (f: number) => `${Math.round(f * 100)}%`
const EXPLORABLE: ReadonlySet<string> = new Set(['goal', 'band'])

/** Why a decision is never explored or revived (the "never" list), or null. */
export function exploreExclusion(f: TargetFacts, d: Pick<Decision, 'layer' | 'action' | 'goalBidCents' | 'goal'>, activity: TargetActivity | undefined): string | null {
  if (!EXPLORABLE.has(d.layer) || d.action === 'brake') return `the ${d.layer.replace('_', '-')} layer decides`
  if (d.goalBidCents == null || !d.goal) return 'no goal bid'
  if (f.raiseCap) return `raises wait (${f.raiseCap})`
  if (f.directives?.length) return 'a rule\'s ceiling or floor steers it'
  const o = f.overrides ?? {}
  if (Object.values(o).some((v) => v != null)) return 'an override applies'
  if (activity?.coverDays != null && activity.coverDays < MIN_COVER_DAYS) return `stock cover ${Math.round(activity.coverDays)} days (under ${MIN_COVER_DAYS})`
  return null
}

/** Traffic a day at a bid, from today's: c₀ · (b ÷ today's)^ε, c₀ ≥ MIN_CLICKS_PER_DAY. */
const clicksAt = (c0: number, bid: number, today: number, eps: number) => (today > 0 ? c0 * Math.pow(Math.max(bid, 0) / today, eps) : c0)

/** Expected extra spend a day of `bid` against `base` (cents, ≥ 0). */
export function extraSpend(args: { ratio: number; c0: number; bid: number; base: number; today: number; eps: number }): number {
  const { ratio, c0, bid, base, today, eps } = args
  const at = (b: number) => clicksAt(c0, b, today, eps) * b * ratio
  return Math.max(0, at(bid) - at(base))
}

/** The step bound of an explore or revive bid: one step of the strategy's largest change from the day's anchor, the limits. */
function bounded(ctx: GoalContext, cents: number): number {
  const share = ctx.maxPct / 100
  const stepped = Math.min(ctx.anchor * (1 + share), Math.max(ctx.anchor * (1 - share), cents))
  return clampToRange(Math.round(stepped), ctx.range).cents
}

/**
 * One keyword: a revive option, an explore option, or why neither. `eps`: the response's ε for its traffic (BB-19; the
 * prior's mean without it). A revive's step 2 in shadow is reckoned from step 1's bid (the bid itself has not moved);
 * once on, the day's anchor is that bid, so each step stays one largest change.
 */
export function exploreOption(f: TargetFacts, d: Pick<Decision, 'layer' | 'action' | 'goalBidCents' | 'goal'>, activity: TargetActivity | undefined, eps: number = DEFAULT_EPS): ExploreOption | ExploreSkip {
  const excluded = exploreExclusion(f, d, activity)
  if (excluded) return { targetId: f.targetId, why: excluded }
  const ctx = goalContext(f)
  if (!ctx) return { targetId: f.targetId, why: 'no goal' }
  const g = d.goalBidCents!
  const node = ctx.est.node
  const c0 = Math.max(MIN_CLICKS_PER_DAY, (activity?.clicks14 ?? 0) / REVIVE_QUIET_DAYS)
  const be = f.goal.breakEvenAcos != null && f.goal.breakEvenAcos > 0 ? f.goal.breakEvenAcos : null
  const beBid = be != null ? bidForAcos(be, node.cr, ctx.aov, ctx.ratio) * ctx.factor : Number.POSITIVE_INFINITY

  // ── Revive first: a keyword that sold and went silent, or one cut to the floor long ago and silent. ──
  if (activity) {
    const daily90 = activity.impressions90 / 90
    const silent = daily90 > 0 ? activity.impressions14 / REVIVE_QUIET_DAYS < REVIVE_SILENT_SHARE * daily90 : activity.impressions14 === 0
    const sold = activity.orders90 >= REVIVE_MIN_ORDERS && daily90 > 0
    const floored = f.currentCents <= Math.ceil(ctx.range.lower * FLOOR_BAND) && (activity.daysSinceWrite == null || activity.daysSinceWrite >= FLOOR_LONG_AGO_DAYS)
    if (silent && (sold || floored)) {
      const reason = sold
        ? `silent ${REVIVE_QUIET_DAYS} days (impressions ${daily90 > 0 ? pct0(activity.impressions14 / REVIVE_QUIET_DAYS / daily90) : '0%'} of its 90-day average; ${Math.round(activity.orders90)} order${Math.round(activity.orders90) === 1 ? '' : 's'} in 90 days)`
        : `at the floor ${f.currentCents}¢ with no bid write for ${activity.daysSinceWrite ?? `${FLOOR_LONG_AGO_DAYS}+`} days, and silent`
      const stage = reviveStage(activity.revive, f.dataDay, f.currentCents)
      if (stage.state !== 'step') {
        // Still silent after both steps: no new re-test until 28 days after the first; the memory keeps the episode's start.
        const memory: ReviveMemory = { start: stage.start, fromCents: activity.revive?.fromCents ?? f.currentCents, step: REVIVE_MAX_STEPS, state: 'silent', dataDay: f.dataDay }
        return { targetId: f.targetId, why: `revive: still silent after ${REVIVE_MAX_STEPS} steps since ${stage.start} — at rest until ${stage.until}`, revive: memory, ...(stage.state === 'silent' ? { say: true as const } : {}) }
      }
      const parent = ctx.est.parent
      const parentGoal = parent?.aovCents ? bidForAcos(ctx.goal.aim, parent.cr, parent.aovCents, ctx.ratio) * ctx.factor : 0
      const toward = Math.min(Math.max(g, parentGoal), beBid, ctx.range.upper ?? Number.POSITIVE_INFINITY)
      // One step of the strategy's largest change up from the step before (step 1: from the bid it started at), or from the
      // day's anchor when that is higher.
      const share = 1 + ctx.maxPct / 100
      const before = Math.max(ctx.anchor, stage.fromCents * Math.pow(share, stage.step - 1))
      const want = Math.min(toward, before * share)
      const bid = clampToRange(Math.round(want), ctx.range).cents
      if (bid > f.currentCents) {
        const extra = extraSpend({ ratio: ctx.ratio, c0, bid, base: f.currentCents, today: f.currentCents, eps })
        return {
          targetId: f.targetId, kind: 'revive', bidCents: bid, goalBidCents: g, extraCents: extra, priority: Number.POSITIVE_INFINITY, anchorCents: ctx.anchor,
          words: `${reason} — step ${stage.step} of ${REVIVE_MAX_STEPS} since ${stage.start} → ${bid}¢ (toward ${Math.round(toward)}¢)`,
          revive: { start: stage.start, fromCents: stage.fromCents, step: stage.step, state: 'step', dataDay: f.dataDay },
        }
      }
    }
  }

  // ── Explore: a thin keyword. ──
  const own = ownShare(node)
  if (own >= THIN_CONFIDENCE) return { targetId: f.targetId, why: `not thin (${pct0(own)} of its estimate is its own)` }
  const draw = thompsonCr(node, `${f.targetId}|${f.dataDay}`)
  const hiBid = bidForAcos(ctx.goal.hi, node.cr, ctx.aov, ctx.ratio) * ctx.factor
  const lo = EXPLORE_LOW_SHARE * g
  const hi = Math.min(EXPLORE_HIGH_SHARE * g, hiBid, beBid)
  if (!(hi >= lo)) return { targetId: f.targetId, why: `no room to explore (the band top or break-even sits under ${EXPLORE_LOW_SHARE} × the goal's ${g}¢)` }
  const raw = bidForAcos(ctx.goal.aim, draw, ctx.aov, ctx.ratio) * ctx.factor
  const bid = bounded(ctx, Math.min(hi, Math.max(lo, raw)))
  const extra = extraSpend({ ratio: ctx.ratio, c0, bid, base: g, today: f.currentCents, eps })
  return {
    targetId: f.targetId, kind: 'explore', bidCents: bid, goalBidCents: g, extraCents: extra, priority: crSd(node) * c0, anchorCents: ctx.anchor, draw,
    words: `thin data (${pct0(own)} its own), CR drawn ${pct2(draw)} (pooled ${pct2(node.cr)}) → ${bid}¢ beside the goal's ${g}¢`,
  }
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────────

export interface ExplorePlan {
  budgetCents: number
  budgetFrom: 'strategy' | 'default'
  /** The picks, in the order they were taken, and their expected extra spend together (≤ the budget). */
  picked: ExploreOption[]
  spentCents: number
  /** Options the budget left out. */
  over: ExploreOption[]
}

const isOption = (x: ExploreOption | ExploreSkip): x is ExploreOption => 'kind' in x

/** Revives first, then thin keywords by the largest posterior sd × traffic (ties by id); one that does not fit is left out. */
export function planExplore(items: ReadonlyArray<ExploreOption | ExploreSkip>, budget: { cents: number; from: 'strategy' | 'default' }): ExplorePlan {
  const options = items.filter(isOption)
  const order = [...options].sort((a, b) => (a.kind !== b.kind ? (a.kind === 'revive' ? -1 : 1) : b.priority - a.priority || (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0)))
  const plan: ExplorePlan = { budgetCents: Math.max(0, budget.cents), budgetFrom: budget.from, picked: [], spentCents: 0, over: [] }
  // No budget in the market: exploration is off there — nothing picked and nothing said.
  if (plan.budgetCents <= 0) return plan
  for (const o of order) {
    if (plan.spentCents + o.extraCents <= plan.budgetCents) {
      plan.picked.push(o)
      plan.spentCents += o.extraCents
    } else plan.over.push(o)
  }
  return plan
}

const cents1 = (x: number) => `${Math.round(x * 10) / 10}¢`

/**
 * What each keyword's stored why and evidence gain from the plan: a pick and one the budget left out are said; a revive at
 * rest keeps its memory (evidence.revive) and says so in the days it turns silent. Nothing else is said.
 */
export function exploreWords(plan: ExplorePlan, mode: ExploreMode, skips: ReadonlyArray<ExploreOption | ExploreSkip> = []): { notes: Map<string, string>; evidence: Map<string, Record<string, unknown>> } {
  const notes = new Map<string, string>()
  const evidence = new Map<string, Record<string, unknown>>()
  for (const s of skips) {
    if (isOption(s) || !s.revive) continue
    evidence.set(s.targetId, { revive: s.revive })
    if (s.say) notes.set(s.targetId, s.why)
  }
  const tag = (kind: PickKind) => (mode === 'on' ? kind : `${kind} (shadow)`)
  const budget = `${plan.budgetCents}¢ (${plan.budgetFrom === 'strategy' ? 'the strategy' : 'default'})`
  for (const o of plan.picked) {
    notes.set(o.targetId, `${tag(o.kind)}: ${mode === 'on' ? '' : `would bid ${o.bidCents}¢ — `}${o.words}, expected +${cents1(o.extraCents)} of today's ${budget}`)
    evidence.set(o.targetId, { explore: { kind: o.kind, mode, picked: true, bidCents: o.bidCents, goalBidCents: o.goalBidCents, extraCents: Math.round(o.extraCents * 100) / 100, budgetCents: plan.budgetCents, ...(o.draw != null ? { draw: Math.round(o.draw * 1e6) / 1e6 } : {}) }, ...(o.revive ? { revive: o.revive } : {}) })
  }
  for (const o of plan.over) {
    notes.set(o.targetId, `${tag(o.kind)}: left out — today's ${budget} is taken (it needs +${cents1(o.extraCents)})`)
    evidence.set(o.targetId, { explore: { kind: o.kind, mode, picked: false, bidCents: o.bidCents, goalBidCents: o.goalBidCents, extraCents: Math.round(o.extraCents * 100) / 100, budgetCents: plan.budgetCents } })
  }
  return { notes, evidence }
}

/**
 * `on`: the picked keywords' decisions become their explore or revive bid (layer explore / revive, one step recorded from
 * the day's anchor, the placements measured at the new bid); every other decision is returned as it is. `off` / `shadow`:
 * the same array, untouched. The plan may be the whole market's: only the run's own decisions are touched.
 */
export function applyExplore(decisions: readonly Decision[], facts: readonly TargetFacts[], plan: ExplorePlan, mode: ExploreMode): Decision[] {
  if (mode !== 'on' || !plan.picked.length) return decisions as Decision[]
  const picked = new Map(plan.picked.map((o) => [o.targetId, o]))
  const factsOf = new Map(facts.map((f) => [f.targetId, f]))
  return decisions.map((d) => {
    const o = picked.get(d.targetId)
    const f = factsOf.get(d.targetId)
    // Checked again on the run's own facts: a product cycle's raise cap, or a goal bid that moved since the plan, keeps the
    // goal's decision (the pick's share of the budget then goes unused — never past it).
    if (!o || !f || d.goal == null || exploreExclusion(f, d, undefined) || d.goalBidCents !== o.goalBidCents) return d
    const lanes = applyLaneDirectives(f.lanes, f.laneDirectives)
    return {
      ...d,
      action: o.bidCents !== d.currentCents ? 'write' : 'hold',
      layer: o.kind,
      bidCents: o.bidCents,
      step: { dataDay: d.dataDay, fromCents: o.anchorCents, toCents: o.bidCents },
      placements: lanes.length ? placementsFor(o.bidCents, lanes, d.goal) : d.placements,
      why: `${o.kind}: ${o.words}, expected +${cents1(o.extraCents)} of today's ${plan.budgetCents}¢ (goal: ${d.why})`,
    }
  })
}

/** What the plan did in one run, for the run's line. */
export interface ExploreSummary {
  mode: ExploreMode
  budgetCents: number
  spentCents: number
  explore: number
  revive: number
  over: number
  /** Keywords at rest after a revive found them still silent. */
  silent: number
}

export function summarizeExplore(plan: ExplorePlan, mode: ExploreMode, silent: number): ExploreSummary {
  return {
    mode, budgetCents: plan.budgetCents, spentCents: Math.round(plan.spentCents * 10) / 10,
    explore: plan.picked.filter((o) => o.kind === 'explore').length, revive: plan.picked.filter((o) => o.kind === 'revive').length, over: plan.over.length, silent,
  }
}

/** "explore (shadow): 4 thin, 1 revive, 2 left out, +38.5¢ of 200¢". */
export function exploreSummaryWords(s: ExploreSummary | null | undefined): string {
  if (!s) return ''
  return `explore${s.mode === 'on' ? '' : ` (${s.mode})`}: ${s.explore} thin, ${s.revive} revive${s.over ? `, ${s.over} left out` : ''}${s.silent ? `, ${s.silent} silent` : ''}, +${s.spentCents}¢ of ${s.budgetCents}¢`
}
