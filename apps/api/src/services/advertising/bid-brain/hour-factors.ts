/**
 * BID BRAIN BB-22 — learned hour factors inside the approved hourly plan (design 2026-10-07-hands-off/BRAIN-UPGRADES-
 * DESIGN.md U4 and U4-D1 = A; 2026-10-08-ads-one-brain/DESIGN.md §2.3, D3 = B+: the brain paints, the Owner approves, and
 * the approved plan's cells are the limits). Pure: no database, no clock — hour-factors-store.ts reads, learns, stores
 * and applies; this file is the maths and the words.
 *
 *   curves     per hour of the week (in the plan's time zone) a smooth curve of the product's conversion rate and of what a
 *              click costs per unit of bid:
 *                log rate(d, h) = log(the parent pool's curve) + μ + Σ βj·Bj(h) + γd
 *              Bj a cyclic cubic B-spline over the 24 hours (SPLINE_KNOTS knots, one every 4 hours: smooth over the day and
 *              across midnight), γd a weekday effect; β and γ shrunk to 0 with a prior sd of SHAPE_PRIOR_SD (U4: "shrunk to
 *              0, prior sd 0.3"), μ (the level) free — a Poisson model with a ridge, fitted by Newton's method from zero
 *              (deterministic: the same cells give the same curve). Pooled market → category → product: each pool's curve is
 *              the prior (the offset) of the next, so a product with few orders keeps its category's (else its market's)
 *              shape, and its own hours move it only as far as they carry (design §1: thin products learn from their pool).
 *   conversion (CR)  the product's orders (Amazon's 1-day ones in the hourly feed, as the research reads them: the shape,
 *              never the level) against its clicks — pooled as above
 *   cost (r)   spend against clicks × the plan's bid multiplier in force at that hour of that day (the version of the plan
 *              in force, its target with the campaign's own values, the lanes weighted by their share of spend): what a click
 *              costs per unit of bid, so the plan's own uplift is not read as a dear hour. Dense data — it learns from the
 *              product's own hours now (U4: "CPC-aware factors work now"), shrunk to the market's cost curve; a Min-bid hour
 *              is left out (its cost is the floor's).
 *   factor     f = CR index ÷ r index (U4: f_h = CR_h/CR̄ · r̄/r_h — the relative bid that keeps the aim in that hour),
 *              traffic-weighted to a mean of 1, with its 90 % interval from both curves' posterior spread.
 *   the plan   each campaign's plan: its relative factor per hour (the cell's bid multiplier, 1 + placement % with the lanes
 *              weighted by spend, ÷ the plan's traffic-weighted mean over its serving hours) — "painted"; the move the learned
 *              factor asks of a cell is ρ = f ÷ painted, both measured over the plan's serving hours.
 *   limits     (cellMove) the approved cell is the CEILING — never above the Owner's approved target or placement % (U4-D1:
 *              "your plan sets the highest value for each hour"); hourCellMovePct below its bid multiplier is the FLOOR
 *              (default 30 %, design §5 — the Owner's own setting). ρ is clamped into [1 − hourCellMovePct, 1]; a move smaller
 *              than MIN_FACTOR_MOVE is no move (U4: "written only when it moves ≥ 10 %"); an hour whose interval is wider than
 *              LOW_CONFIDENCE_RATIO stays; an Owner-locked hour never changes; a Min-bid hour stays Min bid (the learned
 *              factor never makes nor ends one); an hour with no target, or a dated event's hour, stays as it is.
 *   delivery   on the placement lanes: each lane the cell declares goes to (1 + p) × ρ − 1, held inside its limits (a lane at
 *              0 % stays 0 %). The keyword bid stays the goal's day level: decide.ts's band reads today's bid without a
 *              factor, so a keyword factor would move only the keywords outside the band while the lanes moved them all.
 *   TOS cap    top of search's conversion against all placements (daily placement report, 7-day attribution), shrunk to
 *              the market's ratio with TOS_PRIOR_ORDERS orders (U4: "pooled at market until a campaign has ≥ 5 TOS
 *              orders"): 1 + p_TOS ≤ ratio × band top ÷ aim (U4 lane cap) — held inside the cell's limits as well.
 */
import { resolveActiveTargetKey, type ScheduleWindow } from '../rank-controller.js'
import { cellRef, DAY_WORDS, hourKey, shrinkIndex, shrinkShares, weekdayOf, Z90, type HourCell } from '../brain/hours-research.js'
import type { PaintTarget } from '../brain/hours-paint.js'
import { laneWords, type LaneName } from './recipe.js'

export type HourFactorMode = 'off' | 'shadow' | 'on'

/** NEXUS_BID_BRAIN_HOUR_FACTORS: off | shadow (default) | on. Anything unrecognised is shadow (never on by accident). */
export function hourFactorMode(env: string | undefined = process.env.NEXUS_BID_BRAIN_HOUR_FACTORS): HourFactorMode {
  const v = (env ?? '').trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false') return 'off'
  if (v === 'on' || v === '1' || v === 'true') return 'on'
  return 'shadow'
}

/** Knots of the cyclic spline over the day (one every 4 hours: the painter's blocks, Perpetua's envelope [PER-6]). */
export const SPLINE_KNOTS = 6
/** U4: the hour curve and the weekday effect shrunk to the parent's with a prior sd of 0.3 (on the log scale). */
export const SHAPE_PRIOR_SD = 0.3
/** U4: a learned factor is written only when it moves the hour by at least 10 %. */
export const MIN_FACTOR_MOVE = 0.1
/** The painter's "too uncertain to move": an hour whose 90 % interval spans more than this ratio stays as the plan has it. */
export const LOW_CONFIDENCE_RATIO = 4
/** The interval ratio up to which an hour's factor is called high confidence. */
export const HIGH_CONFIDENCE_RATIO = 1.6
/** U4: top of search's conversion is pooled at the market until the product's own carries this many orders. */
export const TOS_PRIOR_ORDERS = 5
/** A learned factor is held inside these bounds (a sanity bound: the plan's limits are far narrower). */
export const FACTOR_MIN = 0.25
export const FACTOR_MAX = 4
/** The lanes' share of spend when the product has no placement report (top of search as the research assumes). */
export const DEFAULT_LANE_SHARES: Readonly<Record<LaneName, number>> = { TOP_OF_SEARCH: 0.5, REST_OF_SEARCH: 0.25, PRODUCT_PAGE: 0.25 }

const HOURS = 168
const r4 = (x: number) => Math.round(x * 10_000) / 10_000

// ── The spline (pure) ────────────────────────────────────────────────────────────────────────────────────────────

/** The cardinal cubic B-spline, centred on 0 (support −2..2, in knot spacings). */
function bspline(u: number): number {
  const a = Math.abs(u)
  if (a >= 2) return 0
  if (a >= 1) return (2 - a) ** 3 / 6
  return (4 - 6 * a * a + 3 * a * a * a) / 6
}

/**
 * The cyclic cubic B-spline basis at an hour of the day (its middle, h + 0.5), `knots` uniform knots around the 24 hours:
 * smooth across midnight, and the values sum to 1 at every hour (a partition of unity).
 */
export function cyclicBasis(hour: number, knots = SPLINE_KNOTS): number[] {
  const spacing = 24 / knots
  const x = ((hour % 24) + 24) % 24 + 0.5
  return Array.from({ length: knots }, (_, j) => {
    let u = (x - j * spacing) / spacing
    // Wrap to the nearest copy of the knot around the day.
    u -= knots * Math.round(u / knots)
    return bspline(u)
  })
}

// ── Small dense linear algebra (pure) ───────────────────────────────────────────────────────────────────────────

/** The Cholesky factor L (A = L·Lᵀ) of a symmetric positive-definite matrix; throws when it is not. */
function cholesky(a: readonly number[][]): number[][] {
  const n = a.length
  const l = Array.from({ length: n }, () => Array.from({ length: n }, () => 0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i][j]
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k]
      if (i === j) {
        if (!(s > 0)) throw new Error('hour-factors: the curve\'s information matrix is not positive definite')
        l[i][i] = Math.sqrt(s)
      } else l[i][j] = s / l[j][j]
    }
  }
  return l
}

function choleskySolve(l: readonly number[][], b: readonly number[]): number[] {
  const n = l.length
  const y = Array.from({ length: n }, () => 0)
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= l[i][k] * y[k]; y[i] = s / l[i][i] }
  const x = Array.from({ length: n }, () => 0)
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= l[k][i] * x[k]; x[i] = s / l[i][i] }
  return x
}

function choleskyInverse(l: readonly number[][]): number[][] {
  const n = l.length
  const cols = Array.from({ length: n }, (_, j) => choleskySolve(l, Array.from({ length: n }, (__, i) => (i === j ? 1 : 0))))
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => cols[j][i]))
}

// ── One curve: a Poisson model with a ridge (pure) ──────────────────────────────────────────────────────────────

/** The rows of the curve's design: [μ, β1..βK, γ0..γ6] for each hour of the week (d × 24 + h). */
function designRow(k: number, knots: number): number[] {
  const d = Math.floor(k / 24), h = k % 24
  return [1, ...cyclicBasis(h, knots), ...Array.from({ length: 7 }, (_, w) => (w === d ? 1 : 0))]
}

export interface CurveInput {
  /** Per hour of the week: the count (orders; spend in clicks' worth of the level) and the exposure (what the level expects). */
  y: readonly number[]
  e: readonly number[]
  /** Per hour of the week: the log of the parent pool's index (0 for the market: a flat prior). */
  logPrior?: readonly number[]
  /** The weights an index is measured against (each hour's share of traffic). */
  weights: readonly number[]
  sd?: number
  knots?: number
}

export interface Curve {
  /** Per hour of the week: the log index (the parent's prior plus this pool's own shape), its level left out. */
  log: number[]
  /** Per hour of the week: the variance of the log index relative to the weighted mean (this pool's own part). */
  variance: number[]
  /** The Newton iterations it took. */
  iterations: number
}

/**
 * Fit one pool's curve (pure). The penalised Poisson log-likelihood Σ [y·η − e·exp(η)] − ½ θᵀPθ with
 * η = log(prior) + x·θ is concave, so Newton's method from θ = 0 (with step halving) reaches its one maximum.
 */
export function fitCurve(input: CurveInput): Curve {
  const knots = input.knots ?? SPLINE_KNOTS
  const sd = input.sd ?? SHAPE_PRIOR_SD
  const n = 1 + knots + 7
  const rows = Array.from({ length: HOURS }, (_, k) => designRow(k, knots))
  const prior = input.logPrior ?? Array.from({ length: HOURS }, () => 0)
  const offset = Array.from({ length: HOURS }, (_, k) => (input.e[k] > 0 ? Math.log(input.e[k]) + prior[k] : Number.NEGATIVE_INFINITY))
  const penalty = Array.from({ length: n }, (_, i) => (i === 0 ? 1e-8 : 1 / (sd * sd)))
  const theta = Array.from({ length: n }, () => 0)
  // Start the level at the data's own (it is free; a good start saves iterations).
  const ySum = input.y.reduce((s, v, k) => s + (input.e[k] > 0 ? Math.max(0, v) : 0), 0)
  const eSum = input.e.reduce((s, v, k) => s + (v > 0 ? v * Math.exp(prior[k]) : 0), 0)
  if (eSum > 0) theta[0] = Math.log((ySum + 0.5) / (eSum + 0.5))
  const dot = (x: readonly number[], t: readonly number[]) => x.reduce((s, v, i) => s + v * t[i], 0)
  const objective = (t: readonly number[]) => {
    let s = 0
    for (let k = 0; k < HOURS; k++) {
      if (!(input.e[k] > 0)) continue
      const eta = offset[k] + dot(rows[k], t)
      s += Math.max(0, input.y[k]) * eta - Math.exp(eta)
    }
    return s - 0.5 * t.reduce((acc, v, i) => acc + penalty[i] * v * v, 0)
  }
  let info: number[][] = []
  let iterations = 0
  let current = objective(theta)
  for (; iterations < 100; iterations++) {
    const grad = theta.map((v, i) => -penalty[i] * v)
    info = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? penalty[i] : 0)))
    for (let k = 0; k < HOURS; k++) {
      if (!(input.e[k] > 0)) continue
      const x = rows[k]
      const lambda = Math.exp(offset[k] + dot(x, theta))
      const resid = Math.max(0, input.y[k]) - lambda
      for (let i = 0; i < n; i++) {
        if (x[i] === 0) continue
        grad[i] += resid * x[i]
        for (let j = 0; j < n; j++) if (x[j] !== 0) info[i][j] += lambda * x[i] * x[j]
      }
    }
    const step = choleskySolve(cholesky(info), grad)
    let scale = 1
    let next = theta.map((v, i) => v + step[i])
    let value = objective(next)
    while (!(value >= current - 1e-12) && scale > 1e-6) {
      scale /= 2
      next = theta.map((v, i) => v + scale * step[i])
      value = objective(next)
    }
    const moved = Math.max(...next.map((v, i) => Math.abs(v - theta[i])))
    for (let i = 0; i < n; i++) theta[i] = next[i]
    current = value
    if (moved < 1e-10) { iterations++; break }
  }
  // The information at the maximum (recomputed so it matches θ), its inverse = the posterior covariance.
  info = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? penalty[i] : 0)))
  for (let k = 0; k < HOURS; k++) {
    if (!(input.e[k] > 0)) continue
    const x = rows[k]
    const lambda = Math.exp(offset[k] + dot(x, theta))
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) info[i][j] += lambda * x[i] * x[j]
  }
  const cov = choleskyInverse(cholesky(info))
  const shape = rows.map((x) => dot(x, theta) - theta[0])
  // The variance relative to the weighted mean: z = x − x̄ (the level's own part cancels).
  const wSum = input.weights.reduce((s, w) => s + Math.max(0, w), 0) || 1
  const mean = Array.from({ length: n }, (_, i) => rows.reduce((s, x, k) => s + x[i] * Math.max(0, input.weights[k]), 0) / wSum)
  const variance = rows.map((x) => {
    const z = x.map((v, i) => v - mean[i])
    let v = 0
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) v += z[i] * cov[i][j] * z[j]
    return Math.max(0, v)
  })
  return { log: shape.map((s, k) => prior[k] + s), variance, iterations }
}

/** exp(log), scaled to a weighted mean of 1 (pure). */
export function indexOf(log: readonly number[], weights: readonly number[]): number[] {
  const raw = log.map((x) => Math.exp(x))
  const w = weights.reduce((s, x) => s + Math.max(0, x), 0)
  const mean = w > 0 ? raw.reduce((s, x, k) => s + x * Math.max(0, weights[k]), 0) / w : raw.reduce((s, x) => s + x, 0) / (raw.length || 1)
  return mean > 0 ? raw.map((x) => x / mean) : raw.map(() => 1)
}

// ── The pooled curves (pure) ────────────────────────────────────────────────────────────────────────────────────

/** The hourly cells summed per hour of the week (d × 24 + h). `m`: a cell's bid multiplier (cost only; null leaves it out). */
export function byHourOfWeek(cells: ReadonlyArray<HourCell & { m?: number | null }>): { clicks: number[]; orders: number[]; spend: number[]; costClicks: number[]; costSpend: number[]; costExposure: number[] } {
  const z = () => Array.from({ length: HOURS }, () => 0)
  const out = { clicks: z(), orders: z(), spend: z(), costClicks: z(), costSpend: z(), costExposure: z() }
  for (const c of cells) {
    const k = hourKey(weekdayOf(c.day), c.hour)
    if (k < 0 || k >= HOURS) continue
    const clicks = Math.max(0, c.clicks)
    out.clicks[k] += clicks
    out.orders[k] += Math.max(0, c.orders)
    out.spend[k] += Math.max(0, c.spendCents)
    // A Min-bid hour (m null) says nothing of what a click costs per unit of bid: its cost is the floor's.
    if (c.m === null) continue
    const m = c.m ?? 1
    out.costClicks[k] += clicks
    out.costSpend[k] += Math.max(0, c.spendCents)
    out.costExposure[k] += clicks * (m > 0 ? m : 1)
  }
  return out
}

export interface PoolCells { market: readonly HourCell[]; category: readonly HourCell[] | null; product: ReadonlyArray<HourCell & { m?: number | null }> }

export interface LearnedCurves {
  /** Per hour of the week (d × 24 + h, d 0 = Sunday): the factor and its 90 % interval. */
  f: number[]
  lo: number[]
  hi: number[]
  /** The conversion index (pooled) and the cost-per-unit-of-bid index, each with its standard deviation on the log scale. */
  cr: number[]
  crSd: number[]
  r: number[]
  rSd: number[]
  /** Each hour's share of the product's clicks, shrunk to the market's. */
  share: number[]
}

/** The conversion and cost curves of a product, pooled market → category → product, and its hour factors (pure). */
export function learnCurves(pools: PoolCells, opts: { sd?: number; knots?: number } = {}): LearnedCurves {
  const m = byHourOfWeek(pools.market)
  const c = pools.category ? byHourOfWeek(pools.category) : null
  const p = byHourOfWeek(pools.product)
  const marketShare = shrinkShares(m.clicks, null)
  const share = shrinkShares(p.clicks, marketShare)
  const level = (num: readonly number[], den: readonly number[]) => {
    const a = num.reduce((s, x) => s + x, 0), b = den.reduce((s, x) => s + x, 0)
    return b > 0 ? (a + 0.5) / b : 0
  }
  const fit = (y: readonly number[], exposure: readonly number[], rate: number, logPrior?: readonly number[]) =>
    fitCurve({ y, e: exposure.map((x) => x * rate), logPrior, weights: share, sd: opts.sd, knots: opts.knots })
  // Conversion: market (flat prior) → category → product.
  const crM = fit(m.orders, m.clicks, level(m.orders, m.clicks))
  const crC = c ? fit(c.orders, c.clicks, level(c.orders, c.clicks), crM.log) : null
  const crP = fit(p.orders, p.clicks, level(p.orders, p.clicks), (crC ?? crM).log)
  const crVar = crP.variance.map((v, k) => v + (crC?.variance[k] ?? 0) + crM.variance[k])
  // Cost per unit of bid: the market's cost curve (what a click costs at each hour) is the product's prior; the product's
  // own spend against clicks × the plan's multiplier in force. Spend counts in clicks' worth of the level (y ÷ level).
  const cpcM = level(m.spend, m.clicks) || 1
  const rM = fitCurve({ y: m.spend.map((s) => s / cpcM), e: m.clicks, weights: share, sd: opts.sd, knots: opts.knots })
  const cpcP = level(p.costSpend, p.costExposure) || 1
  const rP = fitCurve({ y: p.costSpend.map((s) => s / cpcP), e: p.costExposure, logPrior: rM.log, weights: share, sd: opts.sd, knots: opts.knots })
  const rVar = rP.variance.map((v, k) => v + rM.variance[k])
  const cr = indexOf(crP.log, share)
  const r = indexOf(rP.log, share)
  const raw = cr.map((x, k) => x / (r[k] || 1))
  const f = indexOf(raw.map((x) => Math.log(Math.max(x, 1e-9))), share).map((x) => Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, x)))
  const sdOf = (k: number) => Math.sqrt(crVar[k] + rVar[k])
  return {
    f: f.map(r4),
    lo: f.map((x, k) => r4(x * Math.exp(-Z90 * sdOf(k)))),
    hi: f.map((x, k) => r4(x * Math.exp(Z90 * sdOf(k)))),
    cr: cr.map(r4), crSd: crVar.map((v) => r4(Math.sqrt(v))),
    r: r.map(r4), rSd: rVar.map((v) => r4(Math.sqrt(v))),
    share: share.map((x) => Math.round(x * 1_000_000) / 1_000_000),
  }
}

// ── The plan (pure) ─────────────────────────────────────────────────────────────────────────────────────────────

/** The lanes' shares of spend (they sum to 1), from the product's placement report, else the default. */
export function laneShares(lanes: ReadonlyArray<{ lane: LaneName; spendShare: number }>): Record<LaneName, number> {
  const total = lanes.reduce((s, l) => s + Math.max(0, l.spendShare), 0)
  if (!(total > 0)) return { ...DEFAULT_LANE_SHARES }
  const out: Record<LaneName, number> = { TOP_OF_SEARCH: 0, REST_OF_SEARCH: 0, PRODUCT_PAGE: 0 }
  for (const l of lanes) out[l.lane] += Math.max(0, l.spendShare) / total
  return out
}

/**
 * A target's bid multiplier: 1 + each lane's placement %, weighted by the lane's share of spend (a lane the target does not
 * declare counts at 0 %). Null for a Min-bid target (its bids are the floor's). Pure.
 */
export function multiplierOf(t: Pick<PaintTarget, 'floor' | 'lanes'> | null | undefined, shares: Readonly<Record<LaneName, number>>): number | null {
  if (!t) return 1
  if (t.floor) return null
  return (Object.keys(shares) as LaneName[]).reduce((s, lane) => s + shares[lane] * (1 + Math.max(0, t.lanes[lane] ?? 0) / 100), 0)
}

/** The plan's week as targets, [d][h] (null: no target that hour, or one that no longer exists). Pure. */
export function planTargets(plan: { windows: unknown; defaultTargetKey: string | null }, targets: ReadonlyMap<string, PaintTarget>): Array<Array<PaintTarget | null>> {
  const windows = (Array.isArray(plan.windows) ? plan.windows : []) as ScheduleWindow[]
  return Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
    const key = resolveActiveTargetKey(windows, plan.defaultTargetKey, d, h)
    return key ? targets.get(key) ?? null : null
  }))
}

export interface LearnedPlan {
  campaignId: string
  scheduleId: string
  /** The schedule as it stood when learned (windows, baseline, its own values, time zone): a change makes the moves stale. */
  basis: string
  /** Per hour of the week: the plan's relative factor (null: a Min-bid hour or no target). */
  painted: Array<number | null>
  /** Per hour of the week: the move the learned factor asks of the cell (ρ = f ÷ painted, over the plan's serving hours), and its 90 % interval. */
  rho: Array<number | null>
  rhoLo: Array<number | null>
  rhoHi: Array<number | null>
}

/** One campaign's plan against the learned factors (pure). */
export function planAgainst(curves: Pick<LearnedCurves, 'f' | 'lo' | 'hi' | 'share'>, week: ReadonlyArray<ReadonlyArray<PaintTarget | null>>, shares: Readonly<Record<LaneName, number>>, ids: { campaignId: string; scheduleId: string; basis: string }): LearnedPlan {
  const mult = Array.from({ length: HOURS }, (_, k) => {
    const t = week[Math.floor(k / 24)]?.[k % 24] ?? null
    return t ? multiplierOf(t, shares) : null
  })
  const serving = mult.map((x) => x != null)
  const w = curves.share.map((s, k) => (serving[k] ? s : 0))
  const wSum = w.reduce((s, x) => s + x, 0)
  const mean = (xs: ReadonlyArray<number | null>) => (wSum > 0 ? xs.reduce<number>((s, x, k) => s + (x ?? 0) * w[k], 0) / wSum : 0)
  const mBar = mean(mult)
  const fBar = mean(curves.f)
  const painted = mult.map((x) => (x != null && mBar > 0 ? r4(x / mBar) : null))
  const rhoAt = (f: number, k: number) => (painted[k] != null && painted[k]! > 0 && fBar > 0 ? r4(f / fBar / painted[k]!) : null)
  return {
    ...ids,
    painted,
    rho: curves.f.map((f, k) => rhoAt(f, k)),
    rhoLo: curves.lo.map((f, k) => rhoAt(f, k)),
    rhoHi: curves.hi.map((f, k) => rhoAt(f, k)),
  }
}

// ── Top of search's conversion (pure) ───────────────────────────────────────────────────────────────────────────

export interface LaneEvidence { tosOrders: number; tosClicks: number; orders: number; clicks: number }
export interface TosLearned {
  /** Top of search's conversion ÷ all placements', pooled; and its 90 % interval. */
  ratio: number
  lo: number
  hi: number
  /** The product's own evidence, and the market's ratio it was shrunk to (null: the market had none; 1 then). */
  orders: number
  clicks: number
  marketRatio: number | null
  /** The cap on top of search's placement %: 1 + p ≤ ratio × hi ÷ aim; null without a goal. */
  capPct: number | null
  goal: { aim: number; hi: number } | null
}

/** Top of search's pooled conversion ratio and the placement cap it sets (pure). Null without any placement data. */
export function tosCap(product: LaneEvidence | null, market: LaneEvidence | null, goal: { aim: number; hi: number } | null): TosLearned | null {
  const ratioOf = (e: LaneEvidence | null) => (e && e.tosClicks > 0 && e.clicks > 0 && e.orders > 0 ? (e.tosOrders / e.tosClicks) / (e.orders / e.clicks) : null)
  const marketRatio = ratioOf(market)
  if (!product && marketRatio == null) return null
  const pool = marketRatio ?? 1
  const own = product ?? { tosOrders: 0, tosClicks: 0, orders: 0, clicks: 0 }
  const crAll = own.clicks > 0 && own.orders > 0 ? own.orders / own.clicks : null
  // No conversion of its own to measure against: the market's ratio stands (U4: pooled at market).
  const ratio = crAll != null ? shrinkIndex(own.tosOrders, own.tosClicks * crAll, pool, TOS_PRIOR_ORDERS) : pool
  const shape = Math.max(0, own.tosOrders) + TOS_PRIOR_ORDERS
  const spread = Z90 / Math.sqrt(shape)
  const capPct = goal && goal.aim > 0 ? Math.max(0, Math.min(900, Math.floor((ratio * (goal.hi / goal.aim) - 1) * 100))) : null
  return {
    ratio: r4(ratio), lo: r4(ratio * Math.exp(-spread)), hi: r4(ratio * Math.exp(spread)),
    orders: own.tosOrders, clicks: own.tosClicks, marketRatio: marketRatio != null ? r4(marketRatio) : null, capPct, goal,
  }
}

// ── Capped days (pure) ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * BB-16's capped days as local days of the research: a UTC data day on which the ingest refused rows at its ceiling (kind
 * `rows`: the day's grain is incomplete) leaves out every local day it touches; an `arrivals` cap leaves the rows whole.
 */
export function cappedLocalDays(capped: ReadonlyArray<{ date: string; kind: string }>, localDayOf: (instant: Date) => string): Array<{ day: string; why: string }> {
  const out = new Map<string, string>()
  for (const c of capped) {
    if (c.kind !== 'rows') continue
    const start = Date.parse(`${c.date}T00:00:00Z`)
    if (!Number.isFinite(start)) continue
    for (const at of [start, start + 12 * 3_600_000, start + 24 * 3_600_000 - 1]) {
      const day = localDayOf(new Date(at))
      if (!out.has(day)) out.set(day, `the hourly feed was capped on ${c.date} (UTC): the day's ad group × placement hours are incomplete`)
    }
  }
  return [...out].map(([day, why]) => ({ day, why })).sort((a, b) => a.day.localeCompare(b.day))
}

// ── One cell, now (pure) ────────────────────────────────────────────────────────────────────────────────────────

export type CellStatus = 'moved' | 'kept' | 'locked' | 'min_bid' | 'no_target' | 'uncertain' | 'stale' | 'event' | 'not_learned'

export interface CellLane { lane: LaneName; from: number; to: number; min: number; max: number }

export interface CellMove {
  status: CellStatus
  /** The cell ("d2h14") and its place in words ("Tue 14:00"). */
  cell: string
  at: string
  /** The scale applied to the cell's bid multiplier (1: none), and the learned one before the limits. */
  scale: number
  asked: number | null
  /** Each lane the cell declares: its approved %, the % now, and its limits. */
  lanes: CellLane[]
  /** The top-of-search cap held a lane lower than the factor alone. */
  capped: boolean
  words: string
}

export interface CellInput {
  d: number
  h: number
  /** The approved cell's lanes (each lane it declares, its placement %); empty for a Min-bid hour or no target. */
  lanes: ReadonlyArray<{ lane: LaneName; pct: number }>
  floor: boolean
  noTarget?: boolean
  locked?: boolean
  /** Why the learned moves are stale for this campaign (its plan changed since), or null. */
  stale?: string | null
  /** A dated event replaced the week this hour. */
  event?: string | null
  /** The learned move at this hour (null: not learned), with its 90 % interval and the factors behind it. */
  rho: number | null
  rhoLo?: number | null
  rhoHi?: number | null
  learned?: number | null
  painted?: number | null
  movePct: number
  tosCapPct?: number | null
  tosRatio?: number | null
}

const times = (x: number) => `×${(Math.round(x * 100) / 100).toFixed(2)}`
const atWords = (d: number, h: number) => `${DAY_WORDS[d]} ${String(h).padStart(2, '0')}:00`

/** The limits of one lane: [its approved % lowered by movePct of its bid multiplier (never below 0 %), its approved %]. */
export function laneLimits(pct: number, movePct: number): { min: number; max: number } {
  const max = Math.max(0, Math.min(900, Math.round(pct)))
  const m = Math.max(0, Math.min(1, movePct / 100))
  const min = Math.max(0, Math.min(max, Math.ceil(((1 + max / 100) * (1 - m) - 1) * 100 - 1e-9)))
  return { min, max }
}

/** What the learned factor does to one approved cell now, inside its limits (pure). */
export function cellMove(c: CellInput): CellMove {
  const cell = cellRef(c.d, c.h)
  const at = atWords(c.d, c.h)
  const kept = (status: CellStatus, words: string): CellMove => ({
    status, cell, at, scale: 1, asked: c.rho, capped: false,
    lanes: c.lanes.map((l) => ({ lane: l.lane, from: l.pct, to: l.pct, ...laneLimits(l.pct, c.movePct) })), words,
  })
  if (c.event) return kept('event', `${at}: the dated event "${c.event}" replaced the week — its own values run`)
  if (c.noTarget) return kept('no_target', `${at}: the plan holds no target this hour — nothing to scale`)
  if (c.floor) return kept('min_bid', `${at}: a Min-bid hour stays Min bid (the learned factor never makes nor ends one)`)
  if (c.locked) return kept('locked', `${at}: an hour the Owner locked (${cell}) — never changed`)
  if (c.stale) return kept('stale', `${at}: ${c.stale}`)
  if (c.rho == null) return kept('not_learned', `${at}: no learned factor for this hour yet — the plan's values run`)
  const m = Math.max(0, Math.min(1, c.movePct / 100))
  const asked = c.rho
  const uncertain = c.rhoLo != null && c.rhoHi != null && c.rhoLo > 0 && c.rhoHi / c.rhoLo > LOW_CONFIDENCE_RATIO
  // The scale inside the cell's limits: never above the approved cell, never more than movePct below it; a move under
  // MIN_FACTOR_MOVE is none, and an hour too uncertain to tell stays.
  let scale = Math.min(1, Math.max(1 - m, asked))
  if (scale > 1 - MIN_FACTOR_MOVE + 1e-9 || uncertain) scale = 1
  const cap = c.tosCapPct ?? null
  const lanes = c.lanes.map((l): CellLane => {
    const lim = laneLimits(l.pct, c.movePct)
    const clamp = (x: number) => Math.max(lim.min, Math.min(lim.max, x))
    const byFactor = clamp(Math.round(((1 + lim.max / 100) * scale - 1) * 100))
    const to = l.lane === 'TOP_OF_SEARCH' && cap != null ? clamp(Math.min(byFactor, cap)) : byFactor
    return { lane: l.lane, from: l.pct, to, ...lim }
  })
  const byFactorOf = (l: CellLane) => Math.max(l.min, Math.min(l.max, Math.round(((1 + l.max / 100) * scale - 1) * 100)))
  const capped = lanes.some((l) => l.lane === 'TOP_OF_SEARCH' && l.to < byFactorOf(l))
  const changed = lanes.filter((l) => l.to !== l.from)
  const factorWords = c.learned != null && c.painted != null ? `learned ${times(c.learned)} against the plan's ${times(c.painted)}` : `learned ${times(asked)} of the plan's`
  const interval = c.rhoLo != null && c.rhoHi != null ? `; 90 %: ${times(c.rhoLo)}–${times(c.rhoHi)}` : ''
  const head = `${at}: ${factorWords} → asks ${times(asked)} of the cell${interval}`
  const factorPart = uncertain
    ? 'too uncertain to move (its 90 % interval is too wide)'
    : m === 0 && asked < 1 ? 'hourCellMovePct is 0: the Owner lets no hour move'
    : scale === 1
      ? asked > 1 ? 'never above the approved cell' : `under the ${Math.round(MIN_FACTOR_MOVE * 100)} % a move needs`
      : `${times(scale)}${scale > asked + 1e-9 ? ` (held at the cell's floor, ${Math.round(m * 100)} % below the approved)` : ''}`
  const capWords = cap != null && capped ? `; top-of-search cap ${cap} %${c.tosRatio != null ? ` (top of search converts ${times(c.tosRatio)} the other placements, pooled)` : ''}` : ''
  const laneText = changed.map((l) => `${laneWords(l.lane)} ${l.from} → ${l.to} % (limits ${l.min}–${l.max} %)`).join(', ')
  if (!changed.length) {
    const why = scale < 1 ? 'every lane it declares is at 0 % (only the keyword bid could lower it, and that stays the goal\'s)' : factorPart
    return { status: uncertain ? 'uncertain' : 'kept', cell, at, scale: 1, asked, lanes, capped: false, words: `${head} — kept: ${why}` }
  }
  return { status: 'moved', cell, at, scale: r4(scale), asked, lanes, capped, words: `${head} — ${factorPart}${capWords}: ${laneText}` }
}

// ── One product's learning (pure) ───────────────────────────────────────────────────────────────────────────────

/** One campaign of the product with an hourly plan: its own hours (each with the multiplier then in force) and its week now. */
export interface LearnCampaign {
  campaignId: string
  scheduleId: string
  basis: string
  cells: ReadonlyArray<HourCell & { m: number | null }>
  week: ReadonlyArray<ReadonlyArray<PaintTarget | null>>
}

export interface LearnInput {
  productId: string
  market: string
  timeZone: string
  /** The local days learned from (oldest first), and those left out with why (events, a capped feed). */
  days: readonly string[]
  leftOut: ReadonlyArray<{ day: string; why: string }>
  pools: { market: readonly HourCell[]; category: readonly HourCell[] | null }
  categoryName?: string | null
  campaigns: readonly LearnCampaign[]
  shares: Readonly<Record<LaneName, number>>
  lanes: { product: LaneEvidence | null; market: LaneEvidence | null }
  goal: { aim: number; hi: number } | null
  confidence: { label: 'high' | 'medium' | 'low'; thin: boolean; ordersPer30d: number; words: string }
}

export interface LearnedHourFactors {
  version: 1
  productId: string
  market: string
  timeZone: string
  window: { from: string | null; to: string | null; days: number }
  leftOut: Array<{ day: string; why: string }>
  curves: LearnedCurves
  plans: LearnedPlan[]
  tos: TosLearned | null
  shares: Record<LaneName, number>
  confidence: LearnInput['confidence']
  evidence: { productClicks: number; productOrders: number; categoryOrders: number | null; marketOrders: number; costCells: number; floorCells: number }
  /** Plain words with no money in them. */
  summary: string[]
}

const PART_LABEL = (p: number) => `${String(p * 4).padStart(2, '0')}–${String(p * 4 + 4).padStart(2, '0')}`

/** A curve by 4-hour part of the day, traffic-weighted (for the words). */
function byPart(index: readonly number[], share: readonly number[]): number[] {
  return Array.from({ length: 6 }, (_, p) => {
    let w = 0, s = 0
    for (let d = 0; d < 7; d++) for (let h = p * 4; h < p * 4 + 4; h++) { const k = d * 24 + h; w += share[k]; s += index[k] * share[k] }
    return w > 0 ? s / w : 1
  })
}

/** Learn one product's hour factors from what was read (pure). */
export function learnHourFactors(input: LearnInput): LearnedHourFactors {
  const product = input.campaigns.flatMap((c) => c.cells)
  const curves = learnCurves({ market: input.pools.market, category: input.pools.category, product })
  const plans = input.campaigns.map((c) => planAgainst(curves, c.week, input.shares, { campaignId: c.campaignId, scheduleId: c.scheduleId, basis: c.basis }))
  const tos = tosCap(input.lanes.product, input.lanes.market, input.goal)
  const sum = (cells: readonly HourCell[], key: 'clicks' | 'orders') => cells.reduce((s, x) => s + Math.max(0, x[key]), 0)
  const evidence = {
    productClicks: sum(product, 'clicks'), productOrders: sum(product, 'orders'),
    categoryOrders: input.pools.category ? sum(input.pools.category, 'orders') : null, marketOrders: sum(input.pools.market, 'orders'),
    costCells: product.filter((c) => c.m !== null && c.clicks > 0).length, floorCells: product.filter((c) => c.m === null && c.clicks > 0).length,
  }
  const days = input.days.length
  const plural = (n: number, w: string) => `${n} ${n === 1 ? w : `${w}s`}`
  const summary: string[] = []
  summary.push(`Learned from ${plural(days, 'day')}${days ? ` (${input.days[0]} to ${input.days[days - 1]}, ${input.timeZone})` : ''}: the product's own ${plural(Math.round(evidence.productOrders), 'order')} from ${plural(Math.round(evidence.productClicks), 'click')} in the hourly feed (1-day attribution), pooled with ${evidence.categoryOrders != null ? `its category${input.categoryName ? ` "${input.categoryName}"` : ''} (${plural(Math.round(evidence.categoryOrders), 'order')}) and ` : ''}the market (${plural(Math.round(evidence.marketOrders), 'order')}).`)
  summary.push(input.confidence.words)
  if (input.leftOut.length) summary.push(`Left out: ${plural(input.leftOut.length, 'day')} (${[...new Set(input.leftOut.map((x) => x.why))].join('; ')}).`)
  const crPart = byPart(curves.cr, curves.share)
  const rPart = byPart(curves.r, curves.share)
  const best = crPart.indexOf(Math.max(...crPart)), worst = crPart.indexOf(Math.min(...crPart))
  summary.push(crPart[best] / Math.max(crPart[worst], 1e-9) < 1.1
    ? 'Conversion (pooled) is about the same all day (within 10 %).'
    : `Conversion (pooled) is best ${PART_LABEL(best)} (${times(crPart[best])} the day's average) and worst ${PART_LABEL(worst)} (${times(crPart[worst])}).`)
  const dear = rPart.indexOf(Math.max(...rPart)), cheap = rPart.indexOf(Math.min(...rPart))
  summary.push(rPart[dear] / Math.max(rPart[cheap], 1e-9) < 1.1
    ? 'A click costs about the same per unit of bid all day (within 10 %; the plan\'s own uplift taken out).'
    : `A click costs most per unit of bid ${PART_LABEL(dear)} (${times(rPart[dear])}) and least ${PART_LABEL(cheap)} (${times(rPart[cheap])}) — the plan's own uplift taken out${evidence.floorCells ? `, ${plural(evidence.floorCells, 'Min-bid hour')} left out` : ''}.`)
  const fMax = curves.f.indexOf(Math.max(...curves.f)), fMin = curves.f.indexOf(Math.min(...curves.f))
  summary.push(`Hour factor: highest ${DAY_WORDS[Math.floor(fMax / 24)]} ${String(fMax % 24).padStart(2, '0')}:00 (${times(curves.f[fMax])}), lowest ${DAY_WORDS[Math.floor(fMin / 24)]} ${String(fMin % 24).padStart(2, '0')}:00 (${times(curves.f[fMin])}) — the bid that keeps the aim each hour, relative to the week.`)
  for (const p of plans) {
    const lower = p.rho.filter((x) => x != null && x < 1 - MIN_FACTOR_MOVE).length
    const serving = p.rho.filter((x) => x != null).length
    summary.push(`Plan of campaign ${p.campaignId}: ${plural(serving, 'serving hour')}; the learned factor asks ${plural(lower, 'hour')} at least ${Math.round(MIN_FACTOR_MOVE * 100)} % below the approved cell (it never raises one above it).`)
  }
  if (tos) {
    summary.push(`Top of search converts ${times(tos.ratio)} the other placements (90 %: ${times(tos.lo)}–${times(tos.hi)}; its own ${plural(tos.orders, 'order')} at top of search, pooled with the market's ${tos.marketRatio != null ? times(tos.marketRatio) : 'none'})${tos.capPct != null ? `: top of search capped at ${tos.capPct} % (its conversion × the band top ÷ the aim), inside each cell's limits` : ': no cap without an ACoS goal'}.`)
  } else summary.push('No placement report for the product or the market: no top-of-search cap.')
  return {
    version: 1, productId: input.productId, market: input.market, timeZone: input.timeZone,
    window: { from: input.days[0] ?? null, to: input.days[days - 1] ?? null, days },
    leftOut: [...input.leftOut], curves, plans, tos, shares: { ...input.shares }, confidence: input.confidence, evidence, summary,
  }
}
