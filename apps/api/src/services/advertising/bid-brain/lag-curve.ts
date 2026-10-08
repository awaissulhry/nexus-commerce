/**
 * BID BRAIN BB-15 (design BRAIN-UPGRADES-DESIGN.md U1b) — the attribution LAG CURVE L(a): the share of a day's final 7-day
 * orders (and sales) that a copy of the day pulled at age a holds, a = 0..14 (age as `ads-report-settle.ts ageDays`
 * counts it: 0 = asked the morning after). Pure: no database, no clock.
 *
 * Amazon keeps adding purchases to a click's day for 7 days (Sponsored Products), and restates for weeks after. BB-13 keeps
 * every copy of a campaign day that changed (AdsDailyVintage); this file turns those copies into a curve.
 *
 *   prior     no data at all: 75 % of the final at age 0 (the industry rule of thumb: 15–30 % of Sponsored Products 7-day
 *             sales arrive after day 1), then half of what is still missing each further day, 1 from the attribution
 *             window on. Worth PRIOR_STRENGTH_ORDERS orders. Never usable on its own (design U1 guardrail).
 *   seed      the settled campaign rows' 1-day ÷ 7-day orders (and sales): the share bought within a day of the click,
 *             taken as the morning-after copy's share, with the same geometric fill (design U1b). Worth
 *             SEED_STRENGTH_ORDERS orders. It overstates age 0 a little (a click late in the day has had less than a day
 *             at the morning pull), so it corrects less than the truth: between today's "no correction" and the truth.
 *   vintages  per age a, over the settled campaign days that hold a copy pulled at age a:
 *               L̂(a) = Σ copy-at-a ÷ Σ final        (a ratio of sums: big days weigh more, a zero day does not divide)
 *             blended with the seed (or prior) by its strength in orders:
 *               L(a) = λ_a · L̂(a) + (1 − λ_a) · L₀(a),   λ_a = final orders at a ÷ (final orders at a + strength)
 *             The final is the day's newest copy once a pull of it was asked at least the attribution window after it
 *             (the settled copy the brain's settled window reads). A copy "at age a" is the newest copy kept at or before
 *             age a, counted only where a pull of the day was really asked at age a (the report jobs) — the vintages keep
 *             only the pulls that changed something, so "no row" alone never means "no change".
 *   shape     monotone (more of the final is known as a day ages: weighted pool-adjacent-violators), bounded to
 *             [MIN_SHARE, 1] (a restatement can lower a day, so a ratio may pass 1), and 1 at age 14 by definition.
 *   pooling   a product keeps its own curve only with PRODUCT_MIN_ORDERS final orders behind it, its market's curve as its
 *             prior (PRODUCT_PRIOR_ORDERS); a product with few orders (GALE) reads its market's.
 *   usable    the brain may nowcast with a curve only when it rests on a seed or on MIN_VINTAGE_DAYS days of vintages
 *             (design U1 guardrails); otherwise young days are ignored, as before BB-15.
 *   nowcast   `maturityOf`: the maturity a copy pulled at age a carries — L(a), refused below MIN_MATURITY (a copy whose
 *             observed numbers would be multiplied by more than NOWCAST_MAX_FACTOR is too young to use).
 *   calibrate the curve fitted WITHOUT the last N settled days, nowcasting each of them from its young copies: the mean
 *             absolute error per age, against reading the young copy as if it were final (no nowcast).
 */
import { attributionWindowDays } from '@nexus/shared/data-vintage'
import type { Maturity, MaturityOf } from './estimator.js'

/** Ages 0..14. */
export const LAG_AGES = 15
/** The prior's share at age 0 when no seed exists (15–30 % of Sponsored Products sales arrive after the first day). */
export const PRIOR_FIRST_SHARE = 0.75
/** Each further day, this share of what is still missing arrives (the geometric fill of the seed and the prior). */
export const FILL_RATE = 0.5
/** A seed's first-day share is held inside [SEED_SHARE_MIN, 1] (a lower ratio says the 1-day data is broken). */
export const SEED_SHARE_MIN = 0.3
/** Settled 7-day orders the 1d/7d seed needs. */
export const SEED_MIN_ORDERS = 10
/** What the seed and the prior are worth, in orders of vintage evidence. */
export const SEED_STRENGTH_ORDERS = 20
export const PRIOR_STRENGTH_ORDERS = 10
/** A product's curve borrows this many orders of its market's curve; it keeps one only with PRODUCT_MIN_ORDERS of its own. */
export const PRODUCT_PRIOR_ORDERS = 20
export const PRODUCT_MIN_ORDERS = 30
/** Days of vintages a curve needs to be usable without a seed (design U1 guardrails). */
export const MIN_VINTAGE_DAYS = 14
/** No age holds less than this share (the curve's own bound; the nowcast refuses far earlier, MIN_MATURITY). */
export const MIN_SHARE = 0.05
/** The nowcast multiplies a young copy's numbers by at most this: observed ÷ L(a) with L(a) ≥ 1 / 2.5 = 40 %. */
export const NOWCAST_MAX_FACTOR = 2.5
export const MIN_MATURITY = 1 / NOWCAST_MAX_FACTOR

export interface LagShares {
  /** L(a) for orders, a = 0..14. */
  orders: number[]
  /** L(a) for sales, a = 0..14. */
  sales: number[]
}

export type LagSource = 'prior' | 'seed' | 'vintages'

/** The settled campaign rows' 1-day and 7-day sums (one market, the seed's days). */
export interface LagSeed {
  orders1d: number
  orders7d: number
  sales1dCents: number
  sales7dCents: number
  /** Settled days behind the sums. */
  days: number
}

export interface LagCurve {
  shares: LagShares
  source: LagSource
  /** The brain may nowcast with it (a seed, or MIN_VINTAGE_DAYS days of vintages). */
  usable: boolean
  basis: {
    /** Distinct days with a vintage point, the campaign-days behind them, and their final orders. */
    vintageDays: number
    campaignDays: number
    finalOrders: number
    /** The seed's first-day shares (null: no seed). */
    seed: { ordersShare: number; salesShare: number; days: number; orders7d: number } | null
    /** What the curve was pooled toward: the seed, the prior, or (a product) its market's curve. */
    priorFrom: 'seed' | 'prior' | 'market'
    priorOrders: number
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const round4 = (x: number) => Math.round(x * 10_000) / 10_000

/** A geometric curve: `first` at age 0, then FILL_RATE of what is missing arrives each day, 1 from `windowDays` on. */
export function fillShares(first: number, windowDays: number): number[] {
  const r = clamp(Number.isFinite(first) ? first : PRIOR_FIRST_SHARE, SEED_SHARE_MIN, 1)
  return Array.from({ length: LAG_AGES }, (_, a) => (a >= windowDays ? 1 : round4(1 - (1 - r) * FILL_RATE ** a)))
}

/** The prior: no data at all. */
export function priorShares(adProduct: string = 'SPONSORED_PRODUCTS'): LagShares {
  const w = attributionWindowDays(adProduct)
  return { orders: fillShares(PRIOR_FIRST_SHARE, w), sales: fillShares(PRIOR_FIRST_SHARE, w) }
}

/** The 1d/7d seed's first-day shares; null with fewer than SEED_MIN_ORDERS settled 7-day orders. */
export function seedFirstShares(seed: LagSeed | null | undefined): { orders: number; sales: number } | null {
  if (!seed || !(seed.orders7d >= SEED_MIN_ORDERS)) return null
  const orders = clamp(seed.orders1d / seed.orders7d, SEED_SHARE_MIN, 1)
  const sales = seed.sales7dCents > 0 ? clamp(seed.sales1dCents / seed.sales7dCents, SEED_SHARE_MIN, 1) : orders
  return { orders: round4(orders), sales: round4(sales) }
}

/** The seed's curve (null: no usable seed). */
export function seedShares(seed: LagSeed | null | undefined, adProduct: string = 'SPONSORED_PRODUCTS'): LagShares | null {
  const first = seedFirstShares(seed)
  if (!first) return null
  const w = attributionWindowDays(adProduct)
  return { orders: fillShares(first.orders, w), sales: fillShares(first.sales, w) }
}

// ── From copies to points ───────────────────────────────────────────────────────────────────────────

/** One campaign day: the copies its vintages kept, and every age a pull of it was asked at. */
export interface DayCopies {
  /** YYYY-MM-DD. */
  date: string
  copies: ReadonlyArray<{ pulledAt: number; ageDays: number; orders: number; salesCents: number }>
  /** The report jobs that covered the day (their age), and the copies' own ages. */
  pulledAges: ReadonlyArray<number>
}

const byPull = (a: { pulledAt: number }, b: { pulledAt: number }) => a.pulledAt - b.pulledAt

/** One AdsDailyVintage row as the fit reads it (Sponsored Products, campaign grain), its market already resolved. */
export interface VintageRow { profileId: string; market: string; entityId: string; date: Date; pulledAt: Date; ageDays: number; orders7d: number | null; sales7dCents: number | null }
/** One ingested campaign report job (the pulls that may have changed nothing, so kept no vintage). */
export interface PullRow { profileId: string; startDate: Date; endDate: Date; createdAt: Date }

const DAY_MS = 86_400_000
const isoOf = (d: Date) => d.toISOString().slice(0, 10)
const midnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
/** Whole days from the END of `day` (midnight UTC) to `at` — ads-report-settle.ts ageDays. */
const ageAt = (day: number, at: Date) => Math.max(0, Math.floor((at.getTime() - (day + DAY_MS)) / DAY_MS))

/** The campaign days of the vintages, per market, each with every age a pull of it was asked at (jobs ∪ its copies). */
export function dayCopiesOf(vintages: readonly VintageRow[], pulls: readonly PullRow[]): Map<string, Array<DayCopies & { entityId: string; profileId: string }>> {
  const ages = new Map<string, Set<number>>()
  for (const j of pulls) {
    const from = midnight(j.startDate)
    const to = midnight(j.endDate)
    if (!(to >= from) || (to - from) / DAY_MS > 62) continue
    for (let t = from; t <= to; t += DAY_MS) {
      const k = `${j.profileId}|${isoOf(new Date(t))}`
      ;(ages.get(k) ?? ages.set(k, new Set()).get(k)!).add(ageAt(t, j.createdAt))
    }
  }
  const days = new Map<string, DayCopies & { entityId: string; profileId: string; market: string; copies: Array<DayCopies['copies'][number]>; pulledAges: number[] }>()
  for (const v of vintages) {
    const date = isoOf(v.date)
    const k = `${v.profileId}|${v.entityId}|${date}`
    let d = days.get(k)
    if (!d) {
      d = { date, entityId: v.entityId, profileId: v.profileId, market: v.market, copies: [], pulledAges: [...(ages.get(`${v.profileId}|${date}`) ?? [])].sort((a, b) => a - b) }
      days.set(k, d)
    }
    d.copies.push({ pulledAt: v.pulledAt.getTime(), ageDays: v.ageDays, orders: v.orders7d ?? 0, salesCents: v.sales7dCents ?? 0 })
  }
  const out = new Map<string, Array<DayCopies & { entityId: string; profileId: string }>>()
  for (const d of days.values()) {
    const { market, ...rest } = d
    const list = out.get(market)
    if (list) list.push(rest)
    else out.set(market, [rest])
  }
  return out
}

/** The day's final copy: its newest, once a pull was asked at least the attribution window after it; else null. */
export function settledFinal(d: DayCopies, windowDays: number): { orders: number; salesCents: number; age: number } | null {
  if (!d.copies.length) return null
  const oldest = Math.max(...d.pulledAges, ...d.copies.map((c) => c.ageDays))
  if (oldest < windowDays) return null
  const last = [...d.copies].sort(byPull)[d.copies.length - 1]
  return { orders: Math.max(0, last.orders), salesCents: Math.max(0, last.salesCents), age: oldest }
}

/** The copy Nexus held at age `age`: the newest kept at or before it — only where a pull was asked at that age. */
export function copyAt(d: DayCopies, age: number): { orders: number; salesCents: number } | null {
  if (!d.pulledAges.includes(age) && !d.copies.some((c) => c.ageDays === age)) return null
  let best: DayCopies['copies'][number] | null = null
  for (const c of d.copies) if (c.ageDays <= age && (!best || c.pulledAt >= best.pulledAt)) best = c
  return best ? { orders: Math.max(0, best.orders), salesCents: Math.max(0, best.salesCents) } : null
}

/** Per age: what was known and what came to be final, summed over the settled days observed at that age. */
export interface AgeSums { knownOrders: number; knownSales: number; finalOrders: number; finalSales: number; campaignDays: number }
export interface LagPoints {
  byAge: AgeSums[]
  /** Distinct days with at least one point, the campaign-days behind them and their final orders. */
  days: number
  campaignDays: number
  finalOrders: number
}

/** The points of a set of campaign days (one market, or one product's campaigns). */
export function lagPoints(days: readonly DayCopies[], windowDays: number): LagPoints {
  const byAge: AgeSums[] = Array.from({ length: LAG_AGES }, () => ({ knownOrders: 0, knownSales: 0, finalOrders: 0, finalSales: 0, campaignDays: 0 }))
  const dates = new Set<string>()
  let campaignDays = 0
  let finalOrders = 0
  for (const d of days) {
    const final = settledFinal(d, windowDays)
    if (!final) continue
    let used = false
    for (let a = 0; a < LAG_AGES && a <= final.age; a++) {
      const known = copyAt(d, a)
      if (!known) continue
      const s = byAge[a]
      s.knownOrders += known.orders
      s.knownSales += known.salesCents
      s.finalOrders += final.orders
      s.finalSales += final.salesCents
      s.campaignDays += 1
      used = true
    }
    if (!used) continue
    dates.add(d.date)
    campaignDays += 1
    finalOrders += final.orders
  }
  return { byAge, days: dates.size, campaignDays, finalOrders }
}

// ── The fit ─────────────────────────────────────────────────────────────────────────────────────────

/** Weighted pool-adjacent-violators: the closest non-decreasing sequence (least squares, weights `w`). */
export function isotonic(values: readonly number[], weights: readonly number[]): number[] {
  const blocks: Array<{ v: number; w: number; n: number }> = []
  values.forEach((v, i) => {
    blocks.push({ v, w: Math.max(1e-9, weights[i] ?? 1), n: 1 })
    while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
      const b = blocks.pop()!
      const a = blocks.pop()!
      const w = a.w + b.w
      blocks.push({ v: (a.v * a.w + b.v * b.w) / w, w, n: a.n + b.n })
    }
  })
  return blocks.flatMap((b) => Array.from({ length: b.n }, () => b.v))
}

/** Monotone, inside [MIN_SHARE, 1], 1 at the last age. */
export function shapeShares(raw: readonly number[], weights: readonly number[]): number[] {
  const mono = isotonic(raw.map((x) => (Number.isFinite(x) ? x : 1)), weights)
  return mono.map((x, a) => (a === LAG_AGES - 1 ? 1 : round4(clamp(x, MIN_SHARE, 1))))
}

/** The prior a fit pools toward: its curve, its strength in orders, and where it comes from. */
export interface LagPrior { shares: LagShares; strengthOrders: number; from: 'seed' | 'prior' | 'market' }

/** The prior of a market: its seed when it has one, else the default prior. */
export function marketPrior(seed: LagSeed | null | undefined, adProduct: string = 'SPONSORED_PRODUCTS'): LagPrior {
  const s = seedShares(seed, adProduct)
  return s ? { shares: s, strengthOrders: SEED_STRENGTH_ORDERS, from: 'seed' } : { shares: priorShares(adProduct), strengthOrders: PRIOR_STRENGTH_ORDERS, from: 'prior' }
}

/** Fit a curve to its points, pooled toward `prior` (see the header). */
export function fitLagCurve(points: LagPoints, prior: LagPrior, opts: { seed?: LagSeed | null } = {}): LagCurve {
  const k = Math.max(0, prior.strengthOrders)
  const blend = (key: 'orders' | 'sales') => {
    const raw: number[] = []
    const weights: number[] = []
    for (let a = 0; a < LAG_AGES; a++) {
      const s = points.byAge[a]
      const final = key === 'orders' ? s.finalOrders : s.finalSales
      const known = key === 'orders' ? s.knownOrders : s.knownSales
      const lambda = s.finalOrders > 0 ? s.finalOrders / (s.finalOrders + k) : 0
      const observed = final > 0 ? known / final : prior.shares[key][a]
      raw.push(lambda * observed + (1 - lambda) * prior.shares[key][a])
      weights.push(s.finalOrders + k + 1e-6)
    }
    return shapeShares(raw, weights)
  }
  const shares = { orders: blend('orders'), sales: blend('sales') }
  const first = seedFirstShares(opts.seed)
  const fromVintages = points.days >= MIN_VINTAGE_DAYS && points.finalOrders > 0
  const seeded = prior.from === 'seed' || (prior.from === 'market' && !!first)
  const source: LagSource = fromVintages ? 'vintages' : seeded ? 'seed' : 'prior'
  return {
    shares,
    source,
    usable: fromVintages || seeded || prior.from === 'market',
    basis: {
      vintageDays: points.days,
      campaignDays: points.campaignDays,
      finalOrders: points.finalOrders,
      seed: first && opts.seed ? { ordersShare: first.orders, salesShare: first.sales, days: opts.seed.days, orders7d: opts.seed.orders7d } : null,
      priorFrom: prior.from,
      priorOrders: k,
    },
  }
}

/** A product's own curve, its market's curve as the prior; null with fewer than PRODUCT_MIN_ORDERS final orders. */
export function fitProductCurve(points: LagPoints, market: LagCurve): LagCurve | null {
  if (points.finalOrders < PRODUCT_MIN_ORDERS || !market.usable) return null
  const curve = fitLagCurve(points, { shares: market.shares, strengthOrders: PRODUCT_PRIOR_ORDERS, from: 'market' })
  return { ...curve, source: 'vintages', usable: true }
}

/** Check stored shares: two arrays of LAG_AGES numbers in (0, 1], non-decreasing. Null when anything is off. */
export function parseShares(v: unknown): LagShares | null {
  const ok = (xs: unknown): xs is number[] => Array.isArray(xs) && xs.length === LAG_AGES
    && xs.every((x, i) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 1 && (i === 0 || x >= (xs[i - 1] as number) - 1e-9))
  const o = v as { orders?: unknown; sales?: unknown } | null
  return o && ok(o.orders) && ok(o.sales) ? { orders: [...o.orders], sales: [...o.sales] } : null
}

// ── The nowcast's maturity ──────────────────────────────────────────────────────────────────────────

const FULL: Maturity = Object.freeze({ orders: 1, sales: 1 })

/**
 * The maturity of a copy pulled at age `pullAge` under `shares`: L(a) for orders and for sales; 1 from age 15 on (past
 * the curve); null below MIN_MATURITY — too young to nowcast (its numbers would be multiplied by more than 2.5).
 */
export function maturityOf(shares: LagShares): MaturityOf {
  return (pullAge: number) => {
    if (!Number.isFinite(pullAge) || pullAge >= LAG_AGES) return FULL
    const a = Math.max(0, Math.floor(pullAge))
    const orders = shares.orders[a]
    const sales = shares.sales[a]
    if (!(orders >= MIN_MATURITY) || !(sales >= MIN_MATURITY)) return null
    return { orders, sales }
  }
}

// ── Calibration ─────────────────────────────────────────────────────────────────────────────────────

export interface CalibrationAge {
  age: number
  /** Settled days nowcast from a copy of this age. */
  days: number
  /** Mean absolute error in orders per day: the nowcast (copy ÷ L(a)) and the copy read as final (no nowcast). */
  maeOrders: number
  maeOrdersRaw: number
  /** Σ|error| ÷ Σ final, in percent: orders and sales (sales as a share only). Null when the days sold nothing. */
  errorPct: number | null
  errorPctRaw: number | null
  salesErrorPct: number | null
  salesErrorPctRaw: number | null
  /** Σ(nowcast − final) ÷ Σ final, in percent: below 0 the nowcast falls short. */
  biasPct: number | null
  /** The curve's share at this age, in percent; `used` false: below MIN_MATURITY, so the brain leaves such copies out. */
  sharePct: number
  used: boolean
}

export interface Calibration {
  /** The settled days checked (the newest `evalDays`), and the days the checked curve was fitted on (older ones). */
  from: string
  to: string
  evalDays: number
  trainDays: number
  /** The checked curve's source (fitted without the checked days). */
  source: LagSource
  ages: CalibrationAge[]
  /** All ages together, weighted by days. */
  overall: { days: number; maeOrders: number; maeOrdersRaw: number; errorPct: number | null; errorPctRaw: number | null }
}

const pctOf = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null)
const round2 = (x: number) => Math.round(x * 100) / 100

/**
 * How well the curve predicts: the market's settled days, the newest `evalDays` of them held out; a curve fitted on the
 * older days (pooled toward `prior`) nowcasts each held-out day from its campaigns' copies at each young age (the market's
 * day = the sum over its campaigns observed at that age), against the day's final. Null when no day can be checked.
 */
export function calibrate(days: readonly DayCopies[], prior: LagPrior, opts: { evalDays: number; windowDays: number; seed?: LagSeed | null }): Calibration | null {
  const settled = days.filter((d) => settledFinal(d, opts.windowDays))
  const dates = [...new Set(settled.map((d) => d.date))].sort()
  if (!dates.length) return null
  const evalDates = new Set(dates.slice(-Math.max(1, opts.evalDays)))
  const train = settled.filter((d) => !evalDates.has(d.date))
  const curve = fitLagCurve(lagPoints(train, opts.windowDays), prior, { seed: opts.seed })
  const maturity = maturityOf(curve.shares)
  const ages: CalibrationAge[] = []
  for (let a = 0; a < Math.min(LAG_AGES, opts.windowDays); a++) {
    const m = maturity(a)
    let n = 0
    let ae = 0
    let aeRaw = 0
    let bias = 0
    let finalSum = 0
    let salesAe = 0
    let salesAeRaw = 0
    let salesFinal = 0
    for (const date of evalDates) {
      let known = 0
      let knownSales = 0
      let final = 0
      let finalSales = 0
      let seen = false
      for (const d of settled) {
        if (d.date !== date) continue
        const f = settledFinal(d, opts.windowDays)!
        if (a >= f.age) continue
        const c = copyAt(d, a)
        if (!c) continue
        seen = true
        known += c.orders
        knownSales += c.salesCents
        final += f.orders
        finalSales += f.salesCents
      }
      if (!seen) continue
      n += 1
      const share = m ?? { orders: curve.shares.orders[a], sales: curve.shares.sales[a] }
      const nowcast = known / share.orders
      const nowcastSales = knownSales / share.sales
      ae += Math.abs(nowcast - final)
      aeRaw += Math.abs(known - final)
      bias += nowcast - final
      finalSum += final
      salesAe += Math.abs(nowcastSales - finalSales)
      salesAeRaw += Math.abs(knownSales - finalSales)
      salesFinal += finalSales
    }
    if (!n) continue
    ages.push({
      age: a, days: n, maeOrders: round2(ae / n), maeOrdersRaw: round2(aeRaw / n),
      errorPct: pctOf(ae, finalSum), errorPctRaw: pctOf(aeRaw, finalSum),
      salesErrorPct: pctOf(salesAe, salesFinal), salesErrorPctRaw: pctOf(salesAeRaw, salesFinal),
      biasPct: pctOf(bias, finalSum), sharePct: Math.round(curve.shares.orders[a] * 1000) / 10, used: !!m,
    })
  }
  const total = ages.reduce((s, x) => s + x.days, 0)
  const wavg = (pick: (x: CalibrationAge) => number) => (total ? round2(ages.reduce((s, x) => s + pick(x) * x.days, 0) / total) : 0)
  const wpct = (pick: (x: CalibrationAge) => number | null) => {
    const usable = ages.filter((x) => pick(x) != null)
    const n = usable.reduce((s, x) => s + x.days, 0)
    return n ? Math.round((usable.reduce((s, x) => s + pick(x)! * x.days, 0) / n) * 10) / 10 : null
  }
  const evalList = [...evalDates].sort()
  return {
    from: evalList[0], to: evalList[evalList.length - 1], evalDays: evalList.length,
    trainDays: new Set(train.map((d) => d.date)).size, source: curve.source, ages,
    overall: { days: total, maeOrders: wavg((x) => x.maeOrders), maeOrdersRaw: wavg((x) => x.maeOrdersRaw), errorPct: wpct((x) => x.errorPct), errorPctRaw: wpct((x) => x.errorPctRaw) },
  }
}
