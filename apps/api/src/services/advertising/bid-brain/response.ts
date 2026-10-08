/**
 * BID BRAIN BB-19 (design BRAIN-UPGRADES-DESIGN.md U2; the Owner's pick U2-D1 = A) — the bid response: how a keyword's
 * clicks change with its bid, and the most profitable bid inside the Owner's band. SHADOW ONLY: it decides nothing. Each
 * full run logs, beside today's goal bid, the bid U2 would set and the marginal ACoS of the last euro (the stored why and
 * `evidence.response`); every decision, write and step stays the goal's, byte for byte.
 *
 *   response   clicks(b) = C₀ · (b / b₀)^ε  ·  paid CPC(b) = r̂ · b (lane-aware, BB-18)  ·  a click is worth v = CR̂ · AOV̂
 *   ε          a prior per market, Gamma(mean 0.8, sd 0.4), read in its normal form and pooled market → product (a
 *              Gaussian hierarchy: a product's ε sits within 0.25 of its market's; the market mean learns from the OTHER
 *              products, the product from its own — no move is counted twice). The evidence is natural bid moves: a
 *              serving move of ≥ 10 % with no other move of the keyword 3 days before or after, compared over matched days
 *              (3–7) with the clicks of the ad group's keywords that did not move (difference in differences):
 *                ε̂ = [ln(c_after ÷ c_before) − ln(x_after ÷ x_before)] ÷ ln(b_after ÷ b_before), Poisson variance (+½)
 *              Until ε is measured (posterior sd < 0.25), the campaign's top-of-search impression share leans it:
 *              ≥ 50 % → inelastic (× 0.7); < 15 % while the paid CPC is ≥ 0.9 × the bid → bid-limited (× 1.25)
 *   profit     (v · BE − r̂ · b) · clicks(b) is highest at b* = ε/(1+ε) · v · BE ÷ r̂, where the marginal ACoS equals
 *              break-even (BE, the contribution margin share) and the average ACoS is BE · ε/(1+ε)
 *   mACoS      at any bid: ACoS(b) · (1 + ε)/ε — what the last euro of ad sales cost
 *   phase      PROFIT (or none) → b* inside the band · GROW → the highest bid whose marginal ACoS stays ≤ the band top ·
 *              LAUNCH, CLEAR_STOCK, DEFEND → none (the goal's ramp or floor decides). Never outside the band, never above
 *              break-even, then exactly the goal's tail (decide.ts): a thin keyword held at its parent's, the hour factor,
 *              a rule's ceiling or floor, one confidence-scaled step from the day's anchor, the limits
 *   capped     a campaign that spent ≥ 95 % of its daily budget on 3 of the last 7 settled days: a raise buys no clicks
 *              (ε = 0 upward), so the profit-best bid is never above today's
 *
 *   NEXUS_BID_BRAIN_RESPONSE = off · shadow (default). There is no `on`: U2 may write only once probes have measured ε for
 *   the product (posterior sd < 0.25, BB-21). Not read: Amazon's theme bid recommendations — fetched on demand only today
 *   (no stored snapshot), and a daily read would be a new Amazon call in production; a later step.
 *
 * Pure: no database, no clock. The loaders are response-explore.ts.
 */
import type { Decision, TargetFacts } from './decide.js'
import { SHARE_FLOOR_HI_FACTOR } from './decide.js'
import { estimate, laneCpcRatio, type Estimate } from './estimator.js'
import { isGoal, resolveGoal, type Goal } from './goal.js'
import { applyDirectives, bidForAcos, clampToRange, DEFAULT_MAX_CHANGE_PCT, expectedAcos, limitRange, raiseCap, stepFrom } from './recipe.js'

export type ResponseMode = 'off' | 'shadow'

/** The switch. Anything but off is shadow (there is no `on` yet). */
export function responseMode(env: string | undefined = process.env.NEXUS_BID_BRAIN_RESPONSE): ResponseMode {
  const v = (env ?? '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false' ? 'off' : 'shadow'
}

/** The prior per market (design U2): Gamma(mean 0.8, sd 0.4), an assumption from the literature until measured. */
export const EPS_PRIOR_MEAN = 0.8
export const EPS_PRIOR_SD = 0.4
/** How far a product's ε may sit from its market's (sd). */
export const EPS_PRODUCT_SD = 0.25
/** Under this posterior sd, ε counts as measured (design U2: the shadow ends there). */
export const EPS_MEASURED_SD = 0.25
export const EPS_MAX = 3
/** A natural move: at least 10 %, matched over 3–7 days on each side with no other move of the keyword. */
export const MOVE_MIN_SHARE = 0.1
export const MOVE_MIN_DAYS = 3
export const MOVE_MAX_DAYS = 7
/** Top-of-search impression share leans an unmeasured ε. */
export const TOS_HIGH_SHARE = 0.5
export const TOS_LOW_SHARE = 0.15
export const TOS_BID_LIMITED_RATIO = 0.9
export const TOS_INELASTIC_LEAN = 0.7
export const TOS_BID_LIMITED_LEAN = 1.25
/** Budget-capped: ≥ 95 % of the daily budget spent on 3 of the last 7 settled days. */
export const CAPPED_SPEND_SHARE = 0.95
export const CAPPED_MIN_DAYS = 3
export const CAPPED_WINDOW_DAYS = 7
/** The days of top-of-search share read. */
export const TOS_WINDOW_DAYS = 14

export interface Normal { mean: number; sd: number }
export const EPS_PRIOR: Normal = Object.freeze({ mean: EPS_PRIOR_MEAN, sd: EPS_PRIOR_SD })

/** One measurement of ε with its variance. */
export interface EpsReading { eps: number; variance: number }

/** One natural bid move of a keyword, its matched days, and the keywords beside it that did not move. */
export interface MoveEvent {
  targetId: string
  /** The product (family) its ad group advertises; null: none known (it counts toward the market only). */
  productKey: string | null
  beforeCents: number
  afterCents: number
  /** Matched days on each side (the move's own day is left out: it served both bids). */
  days: number
  clicksBefore: number
  clicksAfter: number
  /** The ad group's keywords with no move over the same days, their clicks (null: none — no control). */
  control: { before: number; after: number } | null
}

const HALF = 0.5

/** One move as a reading of ε (difference in differences against its control). Null when it is no clean move. */
export function moveReading(e: MoveEvent): EpsReading | null {
  if (!(e.beforeCents > 0 && e.afterCents > 0) || e.days < MOVE_MIN_DAYS) return null
  const lr = Math.log(e.afterCents / e.beforeCents)
  if (Math.abs(lr) < Math.log(1 + MOVE_MIN_SHARE) - 1e-12) return null
  let lc = Math.log((e.clicksAfter + HALF) / (e.clicksBefore + HALF))
  let v = 1 / (e.clicksAfter + HALF) + 1 / (e.clicksBefore + HALF)
  if (e.control && e.control.before + e.control.after > 0) {
    lc -= Math.log((e.control.after + HALF) / (e.control.before + HALF))
    v += 1 / (e.control.after + HALF) + 1 / (e.control.before + HALF)
  }
  return { eps: lc / lr, variance: v / (lr * lr) }
}

/** Readings as one (inverse-variance weighted); null with none usable. */
export function combineReadings(readings: ReadonlyArray<EpsReading | null>): EpsReading | null {
  let w = 0
  let s = 0
  for (const r of readings) {
    if (!r || !(r.variance > 0) || !Number.isFinite(r.eps)) continue
    w += 1 / r.variance
    s += r.eps / r.variance
  }
  return w > 0 ? { eps: s / w, variance: 1 / w } : null
}

/** A normal prior updated with one reading (precision-weighted). */
export function updateNormal(prior: Normal, reading: EpsReading | null): Normal {
  if (!reading) return prior
  const p0 = 1 / (prior.sd * prior.sd)
  const p1 = 1 / reading.variance
  return { mean: (prior.mean * p0 + reading.eps * p1) / (p0 + p1), sd: Math.sqrt(1 / (p0 + p1)) }
}

export interface EpsPosterior extends Normal {
  /** Clean moves of its own product, and of the market's other products, it rests on. */
  ownMoves: number
  marketMoves: number
  /** Posterior sd under EPS_MEASURED_SD. */
  measured: boolean
  /** The campaign signal's lean (1: none). */
  lean: number
  /** In words: "prior", "3 moves of its product", "top-of-search share 62% → inelastic". */
  from: string
}

const clampEps = (x: number) => Math.min(EPS_MAX, Math.max(0, x))

/**
 * A product's ε: the market mean learns from the OTHER products' moves (each product's own readings combined first, then
 * read with the products' spread), the product from its own. With no moves at all it is exactly the prior.
 */
export function productEps(eventsByProduct: ReadonlyMap<string | null, readonly MoveEvent[]>, productKey: string | null, prior: Normal = EPS_PRIOR): EpsPosterior {
  const tau2 = EPS_PRODUCT_SD * EPS_PRODUCT_SD
  let market: Normal = { mean: prior.mean, sd: Math.sqrt(Math.max(1e-6, prior.sd * prior.sd - tau2)) }
  let marketMoves = 0
  for (const [key, events] of eventsByProduct) {
    if (key === productKey && key != null) continue
    const readings = events.map(moveReading)
    const r = combineReadings(readings)
    if (!r) continue
    marketMoves += readings.filter(Boolean).length
    market = updateNormal(market, { eps: r.eps, variance: r.variance + tau2 })
  }
  const own = productKey != null ? (eventsByProduct.get(productKey) ?? []).map(moveReading) : []
  const ownReading = combineReadings(own)
  const post = updateNormal({ mean: market.mean, sd: Math.sqrt(market.sd * market.sd + tau2) }, ownReading)
  const ownMoves = own.filter(Boolean).length
  const from = ownMoves || marketMoves
    ? [ownMoves ? `${ownMoves} move${ownMoves === 1 ? '' : 's'} of its product` : null, marketMoves ? `${marketMoves} in the market` : null].filter(Boolean).join(', ')
    : 'prior'
  return { mean: clampEps(post.mean), sd: post.sd, ownMoves, marketMoves, measured: post.sd < EPS_MEASURED_SD, lean: 1, from }
}

/** A campaign's signals: its top-of-search impression share (null: none read) and its budget-capped days. */
export interface CampaignSignal {
  tosShare: number | null
  tosDays: number
  cappedDays: number
}

export const isCapped = (s: CampaignSignal | null | undefined): boolean => !!s && s.cappedDays >= CAPPED_MIN_DAYS

const pct = (f: number) => `${Math.round(f * 1000) / 10}%`

/** The lean of an unmeasured ε from the campaign's top-of-search share (and the keyword's paid CPC ÷ bid). */
export function tosLean(signal: CampaignSignal | null | undefined, ratio: number): { lean: number; words: string | null } {
  const s = signal?.tosShare
  if (s == null || !Number.isFinite(s)) return { lean: 1, words: null }
  if (s >= TOS_HIGH_SHARE) return { lean: TOS_INELASTIC_LEAN, words: `top-of-search share ${pct(s)} → inelastic` }
  if (s < TOS_LOW_SHARE && ratio >= TOS_BID_LIMITED_RATIO) return { lean: TOS_BID_LIMITED_LEAN, words: `top-of-search share ${pct(s)} at CPC/bid ${ratio.toFixed(2)} → bid-limited` }
  return { lean: 1, words: null }
}

/** A keyword's ε: its product's, leaned by its campaign's signal while unmeasured (a measured ε is left as measured). */
export function keywordEps(product: EpsPosterior, signal: CampaignSignal | null | undefined, ratio: number): EpsPosterior {
  if (product.measured) return product
  const { lean, words } = tosLean(signal, ratio)
  if (lean === 1) return product
  return { ...product, mean: clampEps(product.mean * lean), lean, from: `${product.from}; ${words}` }
}

/** The marginal ACoS at an expected ACoS: ACoS · (1 + ε)/ε (null when ε is 0: no extra sales at all). */
export function marginalAcos(acos: number | null, eps: number): number | null {
  if (acos == null || !(eps > 0)) return null
  return (acos * (1 + eps)) / eps
}

/** The profit-best point (before the goal's tail), or why there is none. */
export interface ProfitPoint {
  /** Inside the band and under break-even (cents, unrounded); null: none. */
  cents: number | null
  /** b* (or GROW's mACoS = band top) before any clamp; null: none. */
  rawCents: number | null
  held: string | null
  /** Why there is none. */
  none: string | null
}

/**
 * The most profitable bid inside the band (PROFIT, or no phase) or the highest whose marginal ACoS stays ≤ the band top
 * (GROW), never above break-even. A capped campaign's raise buys no clicks: never above `currentCents`.
 */
export function profitBestBid(a: {
  cr: number
  aovCents: number
  ratio: number
  breakEven: number | null
  goal: Pick<Goal, 'lo' | 'hi' | 'phase'>
  eps: number
  currentCents: number
  capped: boolean
}): ProfitPoint {
  const v = a.cr * a.aovCents
  if (!(v > 0) || !(a.ratio > 0)) return { cents: null, rawCents: null, held: null, none: 'no value per click known' }
  const phase = a.goal.phase ?? 'PROFIT'
  if (phase !== 'PROFIT' && phase !== 'GROW') return { cents: null, rawCents: null, held: null, none: `${phase}: the goal's own aim decides` }
  const be = a.breakEven != null && a.breakEven > 0 ? a.breakEven : null
  if (phase === 'PROFIT' && be == null) return { cents: null, rawCents: null, held: null, none: 'no break-even known (no profit data)' }
  const share = a.eps / (1 + a.eps)
  const raw = phase === 'GROW' ? (share * v * a.goal.hi) / a.ratio : (share * v * be!) / a.ratio
  let cents = raw
  let held: string | null = null
  if (a.capped && cents > a.currentCents) { cents = a.currentCents; held = 'budget capped: a raise buys no clicks' }
  const loBid = bidForAcos(a.goal.lo, a.cr, a.aovCents, a.ratio)
  const hiBid = bidForAcos(a.goal.hi, a.cr, a.aovCents, a.ratio)
  const beBid = be != null ? bidForAcos(be, a.cr, a.aovCents, a.ratio) : Number.POSITIVE_INFINITY
  if (cents < loBid) { cents = loBid; held = `the band bottom ${pct(a.goal.lo)}` }
  const top = Math.min(hiBid, beBid)
  if (cents > top) { cents = top; held = beBid < hiBid ? `break-even ${pct(be!)}` : `the band top ${pct(a.goal.hi)}` }
  return { cents, rawCents: raw, held, none: null }
}

/** What decide.ts's goalBid reads before its tail: the goal, the estimate, r̂, the hour factor, the limits and the anchor. */
export interface GoalContext {
  goal: Goal
  est: Estimate
  aov: number
  ratio: number
  factor: number
  range: ReturnType<typeof limitRange>
  anchor: number
  maxPct: number
}

/** The goal's context for one keyword, exactly as decide.ts goalBid builds it; null when it has no goal. */
export function goalContext(f: TargetFacts): GoalContext | null {
  const resolved = resolveGoal(f.goal)
  if (!isGoal(resolved) || !f.chain.length) return null
  const est = estimate(f.chain, { rootCr: f.rootCr, listPriceCents: f.listPriceCents })
  const aov = est.node.aovCents
  if (aov == null || aov <= 0) return null
  const ratio = laneCpcRatio(f.chain[0].evidence, f.servingCents ?? f.currentCents, f.parentCpcRatio, f.ratioCeiling ?? 1)
  const sameDay = !!f.lastStep && f.lastStep.dataDay >= f.dataDay && f.lastStep.toCents === f.currentCents
  return {
    goal: resolved, est, aov, ratio, factor: f.hourFactor ?? 1, range: limitRange(f.limits, f.lanes),
    anchor: sameDay ? f.lastStep!.fromCents : f.currentCents, maxPct: f.limits.maxChangePct ?? DEFAULT_MAX_CHANGE_PCT,
  }
}

/**
 * decide.ts goalBid's tail for any wanted bid: a thin keyword held at its parent's (raiseCap), the hour factor, a rule's
 * ceiling or floor, one confidence-scaled step from the day's anchor, the limits. A test pins it to decide.ts: the aim's
 * bid through it is the decision's goal bid.
 */
export function goalTail(ctx: GoalContext, f: Pick<TargetFacts, 'directives'>, wantCents: number, parentCents: number | null): number {
  let want = wantCents
  if (parentCents != null && ctx.est.parent?.aovCents) {
    want = raiseCap({ wantCents: want, parentCents, node: ctx.est.node, aovCents: ctx.aov, ratio: ctx.ratio, hi: ctx.goal.hi }).cents
  }
  want *= ctx.factor
  const topBid = bidForAcos(ctx.goal.hi, ctx.est.node.cr, ctx.aov, ctx.ratio)
  const shareTop = bidForAcos(ctx.goal.hi * SHARE_FLOOR_HI_FACTOR, ctx.est.node.cr, ctx.aov, ctx.ratio)
  want = applyDirectives(want, f.directives, topBid, shareTop).cents
  const stepped = stepFrom(ctx.anchor, want, ctx.maxPct, ctx.est.confidence)
  return clampToRange(Math.round(stepped.cents), ctx.range).cents
}

/** The layers whose decision rests on the goal and the evidence: where the response is compared. */
export const GOAL_LAYERS: ReadonlySet<string> = new Set(['goal', 'band', 'limit'])

/** One keyword's response in shadow. */
export interface ResponseNote {
  eps: number
  epsSd: number
  epsFrom: string
  capped: boolean
  /** The profit-best point inside the band (rounded, before the step); null: none (`none` says why). */
  bestCents: number | null
  /** The bid it would set today through the goal's tail; null: none. */
  bidCents: number | null
  goalBidCents: number
  breakEven: number | null
  /** Marginal ACoS at the goal's bid, at the profit-best bid and at today's bid. */
  mAcosGoal: number | null
  mAcosBest: number | null
  mAcosNow: number | null
  none: string | null
  words: string
}

const r2 = (x: number) => Math.round(x * 100) / 100
const pctOr = (x: number | null) => (x == null ? 'n/a' : pct(x))

/**
 * One keyword: the profit-best bid beside the goal's, and the marginal ACoS of the last euro — its product's ε, leaned by
 * its campaign's signal, and the campaign's capped days. Null for a decision that does not rest on the goal (an override,
 * a brake, a give-back) or has no goal bid.
 */
export function responseFor(f: TargetFacts, d: Pick<Decision, 'layer' | 'goalBidCents' | 'goal'>, product: EpsPosterior, signal: CampaignSignal | null | undefined): ResponseNote | null {
  if (!GOAL_LAYERS.has(d.layer) || d.goalBidCents == null || !d.goal) return null
  const ctx = goalContext(f)
  if (!ctx) return null
  const eps = keywordEps(product, signal, ctx.ratio)
  const capped = isCapped(signal)
  const node = ctx.est.node
  const be = f.goal.breakEvenAcos != null && f.goal.breakEvenAcos > 0 ? f.goal.breakEvenAcos : null
  const point = profitBestBid({ cr: node.cr, aovCents: ctx.aov, ratio: ctx.ratio, breakEven: be, goal: ctx.goal, eps: eps.mean, currentCents: f.currentCents, capped })
  let bidCents: number | null = null
  if (point.cents != null) {
    const parent = ctx.est.parent
    const parentPoint = parent?.aovCents
      ? profitBestBid({ cr: parent.cr, aovCents: parent.aovCents, ratio: ctx.ratio, breakEven: be, goal: ctx.goal, eps: eps.mean, currentCents: f.currentCents, capped })
      : null
    bidCents = goalTail(ctx, f, point.cents, parentPoint?.cents ?? null)
  }
  const m = (cents: number | null) => (cents == null ? null : marginalAcos(expectedAcos(cents, node.cr, ctx.aov, ctx.ratio), eps.mean))
  const mAcosGoal = m(d.goalBidCents)
  const mAcosBest = m(bidCents)
  const mAcosNow = m(f.currentCents)
  const epsWords = `ε ${r2(eps.mean)} ± ${r2(eps.sd)}, ${eps.from}${capped ? '; budget capped' : ''}`
  const words = bidCents != null
    ? `profit-best ${bidCents}¢ beside the goal's ${d.goalBidCents}¢ (in band ${Math.round(point.cents!)}¢${point.held ? `, held to ${point.held}` : ''}; ${epsWords}; marginal ACoS ${pctOr(mAcosGoal)} at ${d.goalBidCents}¢, ${pctOr(mAcosBest)} at ${bidCents}¢${be != null ? `, break-even ${pct(be)}` : ''})`
    : `profit-best: none — ${point.none} (${epsWords}; marginal ACoS ${pctOr(mAcosGoal)} at the goal's ${d.goalBidCents}¢)`
  return {
    eps: r2(eps.mean), epsSd: r2(eps.sd), epsFrom: eps.from, capped,
    bestCents: point.cents != null ? Math.round(point.cents) : null, bidCents, goalBidCents: d.goalBidCents, breakEven: be,
    mAcosGoal: mAcosGoal != null ? Math.round(mAcosGoal * 10_000) / 10_000 : null,
    mAcosBest: mAcosBest != null ? Math.round(mAcosBest * 10_000) / 10_000 : null,
    mAcosNow: mAcosNow != null ? Math.round(mAcosNow * 10_000) / 10_000 : null,
    none: point.none, words,
  }
}

/** What the response shadow found in one run, for the run's line. */
export interface ResponseSummary {
  compared: number
  higher: number
  lower: number
  same: number
  /** Keywords with no profit-best point (no break-even, a LAUNCH phase …). */
  none: number
  /** Keywords whose ε rests on moves of their own product. */
  measuredFromMoves: number
  /** Clean bid moves read in the market. */
  moves: number
}

export function summarizeResponse(notes: ReadonlyArray<ResponseNote>, moves: number): ResponseSummary {
  const s: ResponseSummary = { compared: notes.length, higher: 0, lower: 0, same: 0, none: 0, measuredFromMoves: 0, moves }
  for (const n of notes) {
    if (n.bidCents == null) s.none += 1
    else if (n.bidCents > n.goalBidCents) s.higher += 1
    else if (n.bidCents < n.goalBidCents) s.lower += 1
    else s.same += 1
    if (/move/.test(n.epsFrom)) s.measuredFromMoves += 1
  }
  return s
}

/** The run line's words: "profit-best: 40 compared (3 higher, 12 lower, 5 same, 20 none), 2 clean moves". */
export function responseSummaryWords(s: ResponseSummary | null | undefined): string {
  if (!s) return ''
  return `profit-best: ${s.compared} compared (${s.higher} higher, ${s.lower} lower, ${s.same} same, ${s.none} none), ${s.moves} clean move${s.moves === 1 ? '' : 's'}`
}

// ── Natural moves from the history (pure: the loader reads the rows) ──────────────────────────────

/** One candidate move as the loader finds it: a serving move with no other move of the keyword ≥ 3 days either side. */
export interface MoveCandidate {
  targetId: string
  adGroupId: string
  /** 'YYYY-MM-DD' of the move. */
  day: string
  fromCents: number
  toCents: number
  /** The keyword's previous and next move days ('YYYY-MM-DD'; null: none in the history read). */
  prevDay: string | null
  nextDay: string | null
}

const DAY_MS = 86_400_000
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS)
const dayStr = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10)

/**
 * The clean moves of a market as events: matched days n = min(7, the days to the keyword's previous move, to its next,
 * to the window's ends) on each side (the move's day left out), n ≥ 3; the control is the ad group's other keywords with
 * no move over those days. `clicks` holds keyword → day → clicks (days without a row had none); `movedDays` keyword →
 * the days it had any move (a stop's low bid included).
 */
export function moveEventsOf(
  candidates: readonly MoveCandidate[],
  clicks: ReadonlyMap<string, ReadonlyMap<string, number>>,
  movedDays: ReadonlyMap<string, ReadonlySet<string>>,
  groups: ReadonlyMap<string, readonly string[]>,
  productOf: (adGroupId: string) => string | null,
  window: { since: string; until: string },
): MoveEvent[] {
  const out: MoveEvent[] = []
  const lo = dayNum(window.since)
  const hi = dayNum(window.until)
  for (const c of candidates) {
    const d = dayNum(c.day)
    const before = Math.min(MOVE_MAX_DAYS, d - (c.prevDay ? dayNum(c.prevDay) : Number.NEGATIVE_INFINITY) - 1, d - lo)
    const after = Math.min(MOVE_MAX_DAYS, (c.nextDay ? dayNum(c.nextDay) : Number.POSITIVE_INFINITY) - d - 1, hi - d)
    const n = Math.min(before, after)
    if (!(n >= MOVE_MIN_DAYS)) continue
    const sum = (id: string, from: number, to: number) => {
      const days = clicks.get(id)
      let s = 0
      for (let k = from; k <= to; k++) s += days?.get(dayStr(k)) ?? 0
      return s
    }
    const siblings = (groups.get(c.adGroupId) ?? []).filter((id) => {
      if (id === c.targetId) return false
      const moved = movedDays.get(id)
      if (!moved) return true
      for (let k = d - n; k <= d + n; k++) if (moved.has(dayStr(k))) return false
      return true
    })
    const control = siblings.length
      ? { before: siblings.reduce((s, id) => s + sum(id, d - n, d - 1), 0), after: siblings.reduce((s, id) => s + sum(id, d + 1, d + n), 0) }
      : null
    out.push({
      targetId: c.targetId, productKey: productOf(c.adGroupId), beforeCents: c.fromCents, afterCents: c.toCents, days: n,
      clicksBefore: sum(c.targetId, d - n, d - 1), clicksAfter: sum(c.targetId, d + 1, d + n), control,
    })
  }
  return out
}
