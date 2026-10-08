/**
 * ONE BRAIN AB-20 — the proof: does a product make more ad profit under its brain than under today's engines? (design
 * 2026-10-08-ads-one-brain/DESIGN.md §7 "Proof" — the leaders publish vendor claims only, no independent A/B; §8 row AB-20
 * "proof A/B (matched pairs, 4–6 weeks, ad profit)"; BID-BRAIN-DESIGN.md §6 "Proof".) Pure maths: weeks, matched pairs,
 * difference-in-differences, 95 % intervals and the honest "not enough data yet". brain/proof-read.ts reads the data.
 *
 *   measures   ad profit = ad sales × margin − ad spend (the product's contribution margin before ads) — the primary
 *              measure; ACoS = ad spend ÷ ad sales; TACoS = ad spend ÷ the product's total sales; ad orders.
 *   designs    did       the brain product and its matched comparison product, the weeks before the brain started and the
 *                        weeks since: (brain after − brain before) − (comparison after − comparison before). What moves the
 *                        whole market (a season, a price war) is in both and cancels.
 *              pre-post  no comparison product: the brain product's weeks since against its weeks before. What moves the
 *                        market is NOT removed — said so.
 *              matched   no ad weeks before the brain started (a new product): the brain product against its comparison over
 *                        the same weeks since — a difference in level, not a change.
 *   weeks      7-day blocks from the day the brain started: at most `weeks` (4–6), and at least 4 settled ones or nothing is
 *              measured; the same number of weeks right before. A week of the brain product is paired with the same
 *              calendar week of its comparison, so what hits both that week cancels.
 *   intervals  95 %. Additive measures (ad profit, orders): a t interval on the weekly differences with Welch's degrees of
 *              freedom — few weeks give a wide interval, honestly. Ratios (ACoS, TACoS): a bootstrap over whole weeks (2,000
 *              draws, a fixed seed so a rerun answers the same), the brain product and its comparison drawn on the same weeks.
 *              Several pairs of one design: the mean of their differences, their variances added (Satterthwaite's degrees of
 *              freedom); the ratios on the pairs' summed weeks.
 *   enough     a verdict only with ≥ 4 settled weeks since the start and ≥ MIN_ORDERS ad orders on each side the design
 *              compares (the brain's weeks since and, for did / pre-post, its weeks before; the comparison's too). Below:
 *              NOT_ENOUGH_DATA with what is missing — the numbers so far are shown, never a verdict.
 */
import { createHash } from 'node:crypto'

export const PROOF_WEEKS_MIN = 4
export const PROOF_WEEKS_MAX = 6
export const PROOF_WEEKS_DEFAULT = 6
/** Ad orders each side of the comparison needs before a verdict (a rough Poisson floor: ±18 % at 30 orders). */
export const MIN_ORDERS = 30
/** A comparison product's price is within this factor of the brain product's (the price band). */
export const PRICE_BAND_RATIO = 1.5
/** A comparison product's ad spend in the weeks before is within this factor of the brain product's (the spend level). */
export const SPEND_LEVEL_RATIO = 2
export const BOOTSTRAP_DRAWS = 2_000
const DAY_MS = 86_400_000

export type Design = 'did' | 'pre-post' | 'matched'
export const DESIGN_WORDS: Record<Design, string> = {
  did: 'difference-in-differences against a matched comparison product',
  'pre-post': 'before and after on the brain product alone (the market\'s own movement is not removed)',
  matched: 'against a matched comparison product over the same weeks (no ad weeks before the brain started: a level, not a change)',
}

export const MEASURES = ['adProfit', 'acos', 'tacos', 'orders'] as const
export type Measure = (typeof MEASURES)[number]
/** Higher is better for ad profit and orders; lower for ACoS and TACoS. */
const HIGHER_IS_BETTER: Record<Measure, boolean> = { adProfit: true, acos: false, tacos: false, orders: true }
export const MEASURE_WORDS: Record<Measure, string> = { adProfit: 'ad profit', acos: 'ACoS', tacos: 'TACoS', orders: 'ad orders' }

// ── Days and weeks ───────────────────────────────────────────────────────────────────────────────────────────────

/** One product's day: its own campaigns' ad spend, ad sales and ad orders, and its total sales (null: not known). */
export interface DayRow { day: string; spendCents: number; salesCents: number; orders: number; revenueCents: number | null }

export interface WeekSum { spendCents: number; salesCents: number; orders: number; revenueCents: number | null }

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

/**
 * `count` 7-day blocks from `start` (each day without a row counts zero). Total sales: null in a week only when the product's
 * total sales are not known at all (`revenueKnown` false). Pure.
 */
export function weeksOf(rows: readonly DayRow[], start: string, count: number, revenueKnown: boolean): WeekSum[] {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  return Array.from({ length: Math.max(0, count) }, (_, w) => {
    const sum: WeekSum = { spendCents: 0, salesCents: 0, orders: 0, revenueCents: revenueKnown ? 0 : null }
    for (let d = 0; d < 7; d++) {
      const r = byDay.get(addDays(start, w * 7 + d))
      if (!r) continue
      sum.spendCents += r.spendCents
      sum.salesCents += r.salesCents
      sum.orders += r.orders
      if (sum.revenueCents != null) sum.revenueCents += r.revenueCents ?? 0
    }
    return sum
  })
}

const total = (weeks: readonly WeekSum[]): WeekSum => weeks.reduce<WeekSum>((t, w) => ({
  spendCents: t.spendCents + w.spendCents, salesCents: t.salesCents + w.salesCents, orders: t.orders + w.orders,
  revenueCents: t.revenueCents == null || w.revenueCents == null ? null : t.revenueCents + w.revenueCents,
}), { spendCents: 0, salesCents: 0, orders: 0, revenueCents: 0 })

/** Ad profit of a week: ad sales × margin − ad spend (cents); null without a margin. Pure. */
export const adProfitOf = (w: WeekSum, margin: number | null): number | null => (margin == null ? null : w.salesCents * margin - w.spendCents)

// ── Statistics ───────────────────────────────────────────────────────────────────────────────────────────────────

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
/** The sample variance (n − 1); 0 for fewer than two values. */
export const sampleVariance = (xs: readonly number[]): number => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)
}

/** Student's t at 97.5 % (two-sided 95 %) for 1…30 degrees of freedom. */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042]

/**
 * Student's t quantile at 97.5 % for `df` degrees of freedom (a fraction allowed: Welch). The table up to 30 (linear between
 * whole numbers), then the Cornish-Fisher expansion around the normal quantile (error under 0.001 there). Pure.
 */
export function tQuantile975(df: number): number {
  if (!Number.isFinite(df) || df <= 1) return T975[0]
  if (df <= 30) {
    const lo = Math.floor(df)
    const hi = Math.min(30, lo + 1)
    return T975[lo - 1] + (T975[hi - 1] - T975[lo - 1]) * (df - lo)
  }
  const z = 1.959963985
  const z3 = z ** 3, z5 = z ** 5, z7 = z ** 7, z9 = z ** 9
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
    + (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * df ** 4)
}

/** A seeded generator in [0, 1) (mulberry32): the same seed, the same draws. */
export function seededRandom(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32BE(0)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** One measure's estimate with its 95 % interval (null when it cannot be bounded) and how it was bounded. */
export interface Estimate {
  estimate: number | null
  low: number | null
  high: number | null
  /** The variance of the estimate and its degrees of freedom (additive measures), for pooling. */
  variance?: number
  df?: number
  method: 't' | 'bootstrap' | 'none'
  /** Why there is no estimate or no interval. */
  note?: string
}

/** A t interval from an estimate, its variance and its degrees of freedom. Pure. */
export function tInterval(estimate: number, variance: number, df: number): Estimate {
  const half = tQuantile975(df) * Math.sqrt(Math.max(0, variance))
  return { estimate, low: estimate - half, high: estimate + half, variance, df, method: 't' }
}

/** Welch's degrees of freedom for two independent means (variances of the means and sample sizes). Pure. */
export function welchDf(va: number, na: number, vb: number, nb: number): number {
  const num = (va + vb) ** 2
  const den = (na > 1 ? va ** 2 / (na - 1) : 0) + (nb > 1 ? vb ** 2 / (nb - 1) : 0)
  return den > 0 ? num / den : Math.max(1, na + nb - 2)
}

// ── One pair ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One side of a pair: a product's days, its margin (null: unknown) and whether its total sales are known. */
export interface ArmInput { productId: string; margin: number | null; rows: readonly DayRow[]; revenueKnown: boolean }

export interface PairInput {
  brain: ArmInput
  /** The matched comparison product, or null (pre-post). */
  control: ArmInput | null
  /** The day the brain started acting on the product (YYYY-MM-DD). */
  start: string
  /** The newest settled data day. */
  newestDay: string
  /** How many weeks to compare (4–6). */
  weeks: number
}

export interface PairWeeks {
  design: Design
  weeks: number
  after: { brain: WeekSum[]; control: WeekSum[] | null }
  before: { brain: WeekSum[]; control: WeekSum[] | null } | null
  /** The calendar days compared: [from, to] since and before. */
  window: { since: [string, string]; before: [string, string] | null }
}

/**
 * The weeks one pair compares and its design, or why it compares nothing yet: fewer than PROOF_WEEKS_MIN settled weeks since
 * the start, or no ad weeks before the start and no comparison product. Pure.
 */
export function pairWeeks(p: PairInput): PairWeeks | { notEnough: string } {
  const settledDays = daysBetween(p.start, p.newestDay) + 1
  const weeks = Math.min(Math.max(PROOF_WEEKS_MIN, Math.min(PROOF_WEEKS_MAX, Math.round(p.weeks))), Math.floor(Math.max(0, settledDays) / 7))
  if (settledDays < PROOF_WEEKS_MIN * 7 || weeks < PROOF_WEEKS_MIN) {
    return { notEnough: `${Math.max(0, settledDays)} settled day${Math.max(0, settledDays) === 1 ? '' : 's'} since the brain started on ${p.start}; the test needs ${PROOF_WEEKS_MIN * 7} (${PROOF_WEEKS_MIN} full weeks)` }
  }
  const beforeStart = addDays(p.start, -7 * weeks)
  const brainBefore = weeksOf(p.brain.rows, beforeStart, weeks, p.brain.revenueKnown)
  const hasBefore = brainBefore.some((w) => w.spendCents > 0 || w.salesCents > 0)
  if (!hasBefore && !p.control) return { notEnough: `no ad weeks before the brain started on ${p.start} and no comparable product to set against it` }
  const design: Design = p.control ? (hasBefore ? 'did' : 'matched') : 'pre-post'
  const window = { since: [p.start, addDays(p.start, 7 * weeks - 1)] as [string, string], before: hasBefore ? [beforeStart, addDays(p.start, -1)] as [string, string] : null }
  return {
    design, weeks, window,
    after: { brain: weeksOf(p.brain.rows, p.start, weeks, p.brain.revenueKnown), control: p.control ? weeksOf(p.control.rows, p.start, weeks, p.control.revenueKnown) : null },
    before: hasBefore ? { brain: brainBefore, control: p.control ? weeksOf(p.control.rows, beforeStart, weeks, p.control.revenueKnown) : null } : null,
  }
}

type WeekValue = (w: WeekSum, arm: 'brain' | 'control') => number | null

/** The weekly differences of one period (brain − comparison, or the brain alone without one); null when a week has none. */
function diffs(brain: readonly WeekSum[], control: readonly WeekSum[] | null, f: WeekValue): number[] | null {
  const out: number[] = []
  for (let i = 0; i < brain.length; i++) {
    const b = f(brain[i], 'brain')
    const c = control ? f(control[i], 'control') : 0
    if (b == null || c == null) return null
    out.push(b - c)
  }
  return out
}

/** An additive measure of one pair (per week): its estimate, variance, degrees of freedom and interval. Pure. */
export function additiveEstimate(pw: PairWeeks, f: WeekValue): Estimate {
  const a = diffs(pw.after.brain, pw.after.control, f)
  if (!a) return { estimate: null, low: null, high: null, method: 'none', note: 'not measured: a side has no margin' }
  if (pw.design === 'matched' || !pw.before) {
    const v = sampleVariance(a) / a.length
    return tInterval(mean(a), v, a.length - 1)
  }
  const b = diffs(pw.before.brain, pw.before.control, f)
  if (!b) return { estimate: null, low: null, high: null, method: 'none', note: 'not measured: a side has no margin' }
  const va = sampleVariance(a) / a.length
  const vb = sampleVariance(b) / b.length
  return tInterval(mean(a) - mean(b), va + vb, welchDf(va, a.length, vb, b.length))
}

type RatioOf = (t: WeekSum) => { num: number; den: number | null }
const RATIOS: Record<'acos' | 'tacos', RatioOf> = {
  acos: (t) => ({ num: t.spendCents, den: t.salesCents }),
  tacos: (t) => ({ num: t.spendCents, den: t.revenueCents }),
}
const ratio = (t: WeekSum, r: RatioOf): number | null => { const { num, den } = r(t); return den != null && den > 0 ? num / den : null }

/** The ratio difference of one draw of week indices: the design's difference of period ratios (null: a zero denominator). */
function ratioDiff(pws: readonly PairWeeks[], r: RatioOf, pick: (pair: number, period: 'after' | 'before', i: number) => number): number | null {
  const sums = { ba: [] as WeekSum[], ca: [] as WeekSum[], bb: [] as WeekSum[], cb: [] as WeekSum[] }
  pws.forEach((pw, p) => {
    for (let i = 0; i < pw.weeks; i++) {
      const ai = pick(p, 'after', i)
      sums.ba.push(pw.after.brain[ai])
      if (pw.after.control) sums.ca.push(pw.after.control[ai])
      if (pw.before) {
        const bi = pick(p, 'before', i)
        sums.bb.push(pw.before.brain[bi])
        if (pw.before.control) sums.cb.push(pw.before.control[bi])
      }
    }
  })
  const design = pws[0].design
  const ba = ratio(total(sums.ba), r)
  if (ba == null) return null
  if (design === 'matched') { const ca = ratio(total(sums.ca), r); return ca == null ? null : ba - ca }
  const bb = ratio(total(sums.bb), r)
  if (bb == null) return null
  if (design === 'pre-post') return ba - bb
  const ca = ratio(total(sums.ca), r)
  const cb = ratio(total(sums.cb), r)
  return ca == null || cb == null ? null : (ba - bb) - (ca - cb)
}

/**
 * A ratio measure (ACoS or TACoS) over one or more pairs of ONE design: the difference of the period ratios on the summed
 * weeks, and a bootstrap interval over whole weeks (the same draw for the brain product and its comparison). Pure.
 */
export function ratioEstimate(pws: readonly PairWeeks[], which: 'acos' | 'tacos', seed: string, draws = BOOTSTRAP_DRAWS): Estimate {
  if (!pws.length) return { estimate: null, low: null, high: null, method: 'none', note: 'no pair' }
  const r = RATIOS[which]
  const estimate = ratioDiff(pws, r, (_p, _period, i) => i)
  if (estimate == null) return { estimate: null, low: null, high: null, method: 'none', note: which === 'tacos' ? 'not measured: a side has no total sales (or none known) in a period' : 'not measured: a side has no ad sales in a period' }
  const rand = seededRandom(`${seed}:${which}`)
  const out: number[] = []
  let skipped = 0
  for (let d = 0; d < draws; d++) {
    const picks = pws.map((pw) => ({ after: Array.from({ length: pw.weeks }, () => Math.floor(rand() * pw.weeks)), before: Array.from({ length: pw.weeks }, () => Math.floor(rand() * pw.weeks)) }))
    const v = ratioDiff(pws, r, (p, period, i) => picks[p][period][i])
    if (v == null) skipped++
    else out.push(v)
  }
  if (skipped > draws * 0.1) return { estimate, low: null, high: null, method: 'none', note: `too few weeks with sales to bound it (${skipped} of ${draws} draws had none)` }
  out.sort((a, b) => a - b)
  const at = (q: number) => out[Math.min(out.length - 1, Math.max(0, Math.floor(q * out.length)))]
  return { estimate, low: at(0.025), high: at(0.975), method: 'bootstrap' }
}

/** Several pairs' additive estimates of one design pooled: the mean, the variances added, Satterthwaite's df. Pure. */
export function poolAdditive(list: readonly Estimate[]): Estimate {
  const ok = list.filter((e): e is Estimate & { estimate: number; variance: number; df: number } => e.estimate != null && e.variance != null && e.df != null)
  if (!ok.length) return { estimate: null, low: null, high: null, method: 'none', note: list[0]?.note ?? 'no pair measured' }
  if (ok.length === 1) return ok[0]
  const k = ok.length
  const variance = ok.reduce((s, e) => s + e.variance, 0) / (k * k)
  const den = ok.reduce((s, e) => s + (e.variance / (k * k)) ** 2 / Math.max(1, e.df), 0)
  return tInterval(ok.reduce((s, e) => s + e.estimate, 0) / k, variance, den > 0 ? variance ** 2 / den : ok.reduce((s, e) => s + e.df, 0))
}

// ── The verdict ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Verdict = 'better' | 'worse' | 'no difference shown'

/** The verdict of one measure: its interval wholly on one side of zero, in the brain's favour or not. Pure. */
export function verdictOf(measure: Measure, e: Estimate): Verdict | null {
  if (e.low == null || e.high == null) return null
  const up = e.low > 0, down = e.high < 0
  if (!up && !down) return 'no difference shown'
  return up === HIGHER_IS_BETTER[measure] ? 'better' : 'worse'
}

/** The ad orders on each side the design compares, and what is missing for a verdict (empty: enough). Pure. */
export function thinness(pws: readonly PairWeeks[]): { orders: { brainSince: number; brainBefore: number | null; comparisonSince: number | null; comparisonBefore: number | null }; missing: string[] } {
  const sum = (pick: (pw: PairWeeks) => readonly WeekSum[] | null | undefined) => {
    let n = 0, seen = false
    for (const pw of pws) { const w = pick(pw); if (w) { seen = true; n += total(w).orders } }
    return seen ? n : null
  }
  const orders = {
    brainSince: sum((pw) => pw.after.brain) ?? 0,
    brainBefore: sum((pw) => pw.before?.brain),
    comparisonSince: sum((pw) => pw.after.control),
    comparisonBefore: sum((pw) => pw.before?.control),
  }
  const missing: string[] = []
  const need = (n: number | null, side: string) => { if (n != null && n < MIN_ORDERS) missing.push(`${n} ad order${n === 1 ? '' : 's'} ${side} (${MIN_ORDERS} needed)`) }
  need(orders.brainSince, 'on the brain\'s side since it started')
  need(orders.brainBefore, 'on the brain\'s side in the weeks before')
  need(orders.comparisonSince, 'on the comparison\'s side since the brain started')
  need(orders.comparisonBefore, 'on the comparison\'s side in the weeks before')
  return { orders, missing }
}

export interface MeasureResult extends Estimate { verdict: Verdict | null }

export interface DesignResult {
  design: Design
  pairs: number
  weeks: number
  /** Per measure: the estimate per week (ad profit in cents a week, orders a week) or the ratio difference, its interval. */
  measures: Record<Measure, MeasureResult>
  orders: ReturnType<typeof thinness>['orders']
  /** Empty when there is enough data for a verdict. */
  missing: string[]
  enough: boolean
}

/** One design's result over its pairs: every measure with its interval, and a verdict only with enough data. Pure. */
export function designResult(pws: readonly PairWeeks[], margins: ReadonlyArray<{ brain: number | null; control: number | null }>, seed: string): DesignResult {
  const thin = thinness(pws)
  const enough = thin.missing.length === 0
  const perPair = (f: (i: number) => WeekValue) => poolAdditive(pws.map((pw, i) => additiveEstimate(pw, f(i))))
  const adProfit = perPair((i) => (w, arm) => adProfitOf(w, arm === 'brain' ? margins[i].brain : margins[i].control))
  const orders = perPair(() => (w) => w.orders)
  const acos = ratioEstimate(pws, 'acos', seed)
  const tacos = ratioEstimate(pws, 'tacos', seed)
  const withVerdict = (m: Measure, e: Estimate): MeasureResult => ({ ...e, verdict: enough ? verdictOf(m, e) : null })
  return {
    design: pws[0].design, pairs: pws.length, weeks: Math.min(...pws.map((p) => p.weeks)),
    measures: { adProfit: withVerdict('adProfit', adProfit), acos: withVerdict('acos', acos), tacos: withVerdict('tacos', tacos), orders: withVerdict('orders', orders) },
    orders: thin.orders, missing: thin.missing, enough,
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A product as matching sees it. Spend in cents over the weeks before (the brain's) and since (to be comparable at all). */
export interface MatchFacts { productId: string; name: string | null; categoryId: string | null; priceCents: number | null; spendBeforeCents: number; spendSinceCents: number; orders: number }

export interface Match { control: MatchFacts | null; why: string; considered: number }
/** A brain product no comparison was looked for. */
export const MATCH_NONE = 'no product without the brain was looked at'

/**
 * Each brain product's comparison: a non-brain product of the same market (the caller's list), the same category, a price
 * within PRICE_BAND_RATIO, an ad spend in the weeks before within SPEND_LEVEL_RATIO, and ads running in the weeks since —
 * the nearest by price and spend; each comparison used once (brain products in the order given). A criterion the brain
 * product has no data for is not applied, and said so. Pure.
 */
export function matchControls(brains: readonly MatchFacts[], candidates: readonly MatchFacts[]): Map<string, Match> {
  const used = new Set<string>()
  const out = new Map<string, Match>()
  const lnBand = Math.log(PRICE_BAND_RATIO), lnSpend = Math.log(SPEND_LEVEL_RATIO)
  for (const b of brains) {
    const notes: string[] = []
    if (!b.categoryId) notes.push('the brain product has no category: any category')
    if (b.priceCents == null) notes.push('the brain product has no price: any price')
    if (b.spendBeforeCents <= 0) notes.push('no ad spend before the brain started: any spend level')
    const fits = candidates.filter((c) => {
      if (used.has(c.productId) || c.productId === b.productId || c.spendSinceCents <= 0) return false
      if (b.categoryId && c.categoryId !== b.categoryId) return false
      if (b.priceCents != null && (c.priceCents == null || Math.abs(Math.log(c.priceCents / b.priceCents)) > lnBand + 1e-9)) return false
      if (b.spendBeforeCents > 0 && (c.spendBeforeCents <= 0 || Math.abs(Math.log(c.spendBeforeCents / b.spendBeforeCents)) > lnSpend + 1e-9)) return false
      return true
    })
    const distance = (c: MatchFacts) => (b.priceCents != null && c.priceCents ? Math.abs(Math.log(c.priceCents / b.priceCents)) / lnBand : 0)
      + (b.spendBeforeCents > 0 && c.spendBeforeCents > 0 ? Math.abs(Math.log(c.spendBeforeCents / b.spendBeforeCents)) / lnSpend : 0)
    const best = [...fits].sort((x, y) => distance(x) - distance(y) || y.orders - x.orders || x.productId.localeCompare(y.productId))[0] ?? null
    if (best) used.add(best.productId)
    const criteria = `same market${b.categoryId ? ', same category' : ''}${b.priceCents != null ? `, price within ×${PRICE_BAND_RATIO}` : ''}${b.spendBeforeCents > 0 ? `, ad spend before within ×${SPEND_LEVEL_RATIO}` : ''}, ads running since`
    out.set(b.productId, {
      control: best,
      considered: candidates.filter((c) => c.productId !== b.productId).length,
      why: best
        ? `the nearest of ${fits.length} product${fits.length === 1 ? '' : 's'} without the brain that fit (${criteria})${notes.length ? `; ${notes.join('; ')}` : ''}`
        : `no product without the brain fits (${criteria})${notes.length ? `; ${notes.join('; ')}` : ''}`,
    })
  }
  return out
}
