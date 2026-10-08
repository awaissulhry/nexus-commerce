/**
 * ONE BRAIN AB-13 — the brain studies a market's hourly dynamics for one product before it paints that product's hourly
 * plan (design 2026-10-08-ads-one-brain/DESIGN.md §2.3, D3 = B+; Owner 10-08: "the brain paints the hourly plan, but it
 * should always understand the dynamics of the market, research it, and then paint it"). The research: per hour of the
 * week (in the plan's time zone), traffic, cost per click and conversion, pooled product → category → market, with how
 * sure it is, weekday against weekend, the recent trend, the lanes, and a summary in plain words. brain/hours-paint.ts
 * paints from it.
 *
 * THE DATA
 *   shape   the Marketing Stream hours of the last N weeks (default 4, at most 8; today and the days an armed dated event
 *           replaced the week are left out). An hour of a campaign comes from the ad group × placement grain (BB-16,
 *           ams-grain.service.ts loadPlacementHours) where it holds that hour, else from the campaign grain
 *           (AmazonAdsHourlyPerformance) — never both. Conversions here are Amazon's 1-day ones (the campaign grain stores
 *           only those, design F2), the same in both sources, so the curve compares like with like.
 *   level   the daily reports (AmazonAdsDailyPerformance, campaign rows, 7-day attribution) over the same days: the
 *           product's clicks, spend, orders and sales. The curve says WHEN; the level says HOW MUCH.
 *   lanes   the daily placement report (top of search, product pages, rest of search) of the product's campaigns, with
 *           Amazon's top-of-search impression share where it reports one.
 *   pools   product = its own campaigns (brain/ownership.ts; its shared ones only when it has none of its own) ·
 *           category = the market's Sponsored Products campaigns advertising a product filed under its primary category ·
 *           market = every Sponsored Products campaign of the market.
 *
 * THE MATHS (pure, below the loader's types)
 *   conversion  an index per key (a 4-hour block of a weekday, a day part, a weekday, an hour) against the level's own
 *               average, shrunk to the level above it the Gamma–Poisson way: idx = (orders + a) / (expected + a / parent),
 *               expected = clicks × the level's conversion rate, a = PRIOR_ORDERS (the pool counts as three orders of
 *               evidence — design §1: a product below 10 orders in 30 days learns from its category and market). A block
 *               starts from its level's day part × weekday (the separable curve, design U4: log CR = μ + α_hour + β_day)
 *               times the pool's own block residual. Every index is normalised to its level's traffic (click-weighted
 *               mean 1). A block's own data beyond its day part × weekday is shrunk with PRIOR_INTERACTION_ORDERS (design
 *               U4: prior sd 0.3). The 90 % interval adds the block's, its day part's, its weekday's and the level's
 *               posterior shapes (orders + prior weight; lognormal approximation).
 *   cost/click  an index per key, shrunk to the level above with PRIOR_CLICKS clicks of weight.
 *   traffic     each key's share of clicks, shrunk to the level above's share (or flat) with PRIOR_SHARE_CLICKS.
 *   level       the product's 7-day conversion rate and order value shrunk to the category's (else the market's) with
 *               the same prior strength; its expected ACoS = CPC ÷ (CR × order value).
 *   confidence  thin below THIN_ORDERS_PER_30D product orders a 30 days, solid from SOLID_ORDERS_PER_30D; and how much of
 *               the curve each pool carries (product · category · market · flat).
 *
 * Money (cost per click, spend, sales) is in minor units of the campaigns' currency, never converted; sentences that name
 * money are kept apart (`money`) from those that do not (`summary`), so a reader without ad-spend money sees the rest.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { MARKET_TIME_ZONE } from '../ads-market-time.js'
import { isoDayIn, isKnownTimeZone } from '../ads-local-day.js'
import { REPORT_LABEL_TO_PLACEMENT } from '../ads-placement-math.js'
import { loadPlacementHours } from '../ams-grain.service.js'
import { laneOf } from '../bid-brain/plan-hour.js'
import type { LaneName } from '../bid-brain/recipe.js'
import { productCampaigns } from './ownership.js'

export const RESEARCH_WEEKS_DEFAULT = 4
export const RESEARCH_WEEKS_MAX = 8
/** The pool's weight in a conversion index, in orders (design §1, §2.7: "pooled n ≈ 3 / CR"). */
export const PRIOR_ORDERS = 3
/**
 * The weight, in orders, of the separable curve (day part × weekday) in a block's or an hour's own index: what a block
 * does beyond its day part and its weekday is shrunk hard (BRAIN-UPGRADES U4: "shrunk to 0, prior sd 0.3" — a Gamma
 * shape of about 1 / 0.3²), so a few lucky orders in one block do not move the plan.
 */
export const PRIOR_INTERACTION_ORDERS = 10
/** The pool's weight in a cost-per-click index, in clicks. */
export const PRIOR_CLICKS = 20
/** The pool's weight in a traffic share, in clicks. */
export const PRIOR_SHARE_CLICKS = 50
/** Design §1: a product below 10 ad orders in 30 days is thin. */
export const THIN_ORDERS_PER_30D = 10
export const SOLID_ORDERS_PER_30D = 30
/** The brain paints 4-hour blocks (design §2.3, Perpetua's tested envelope [PER-6]): six day parts. */
export const PART_HOURS = 4
export const PARTS = 24 / PART_HOURS
/** The two-sided 90 % normal quantile: the brain moves an hour only when the whole 90 % interval says so (42 blocks a week are judged at once). */
export const Z90 = 1.6449
/** A market conversion curve is only described from this many orders in the window. */
const CURVE_ORDERS = 10
/** A trend of conversion needs this many orders in each half. */
const TREND_ORDERS = 5
/** The read caps: the campaigns one pool reads at most. */
export const MAX_POOL_CAMPAIGNS = 600

export type PoolName = 'product' | 'category' | 'market'
export const POOLS: readonly PoolName[] = ['product', 'category', 'market']

export interface Totals { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }
/** One hour of one local day (summed over a pool's campaigns). */
export interface HourCell extends Totals { day: string; hour: number }
export interface LaneTotals extends Totals { lane: LaneName; topOfSearchSharePct: number | null }

/** What the loader read for one product × market (or what a test makes up). */
export interface ResearchFacts {
  productId: string
  productName: string | null
  market: string
  timeZone: string
  /** The local days researched, oldest first. */
  days: string[]
  /** Days left out of `days`, with why. */
  leftOut: Array<{ day: string; why: string }>
  /** Hourly cells per pool; category null when the product has no category. */
  hours: { product: HourCell[]; category: HourCell[] | null; market: HourCell[] }
  /** Daily-report totals per pool over the same days (7-day attribution). */
  daily: { product: Totals; category: Totals | null; market: Totals }
  lanes: LaneTotals[]
  categoryName: string | null
  campaigns: { product: number; category: number; market: number }
  /** True when the product has no campaign of its own and its shared ones were read. */
  productFromShared?: boolean
  sources: { placementGrainHours: number; campaignGrainHours: number; lateStartCells: number; negativeCells: number; newestArrivalAt: string | null }
}

const ZERO: Totals = Object.freeze({ impressions: 0, clicks: 0, spendCents: 0, orders: 0, salesCents: 0 })
const add = (a: Totals, b: Totals): Totals => ({
  impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, spendCents: a.spendCents + b.spendCents, orders: a.orders + b.orders, salesCents: a.salesCents + b.salesCents,
})
export const totalOf = (cells: readonly Totals[]): Totals => cells.reduce<Totals>((t, c) => add(t, c), { ...ZERO })
const r4 = (x: number) => Math.round(x * 10_000) / 10_000
const r2 = (x: number) => Math.round(x * 100) / 100
/** 0 Sunday … 6 Saturday, as the hourly plans count days. */
export const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay()
export const partOf = (hour: number): number => Math.floor(hour / PART_HOURS)
export const blockKey = (d: number, part: number): number => d * PARTS + part
export const hourKey = (d: number, h: number): number => d * 24 + h
/** "d1h14" — an hour cell as the Owner's locks name it (brain/levers.ts). */
export const cellRef = (d: number, h: number): string => `d${d}h${h}`
export const DAY_WORDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
export const partWords = (part: number): string => `${String(part * PART_HOURS).padStart(2, '0')}–${String((part + 1) * PART_HOURS).padStart(2, '0')}`

// ── Shrinkage (pure) ─────────────────────────────────────────────────────────────────────────────────────────────

/** A conversion index shrunk toward its parent, the Gamma–Poisson way: (orders + a) / (expected + a / parent). */
export function shrinkIndex(orders: number, expected: number, parent: number, a = PRIOR_ORDERS): number {
  const p = parent > 0 && Number.isFinite(parent) ? parent : 1
  return (Math.max(0, orders) + a) / (Math.max(0, expected) + a / p)
}

/** A cost-per-click index shrunk toward its parent with `m` clicks of weight; `levelCpc` is the level's own. */
export function shrinkCpcIndex(spendCents: number, clicks: number, levelCpc: number, parent: number, m = PRIOR_CLICKS): number {
  const p = parent > 0 && Number.isFinite(parent) ? parent : 1
  if (!(levelCpc > 0)) return p
  return (Math.max(0, spendCents) + m * levelCpc * p) / ((Math.max(0, clicks) + m) * levelCpc)
}

/** Each key's share of clicks, shrunk toward the parent's shares (or flat) with `m` clicks of weight; sums to 1. */
export function shrinkShares(clicks: readonly number[], parent: readonly number[] | null, m = PRIOR_SHARE_CLICKS): number[] {
  const n = clicks.length
  const total = clicks.reduce((s, c) => s + Math.max(0, c), 0)
  const prior = parent ?? Array.from({ length: n }, () => 1 / n)
  const priorTotal = prior.reduce((s, p) => s + p, 0) || 1
  return clicks.map((c, i) => (Math.max(0, c) + m * (prior[i] / priorTotal)) / (total + m))
}

/** Scale `index` so its `weights`-weighted mean is 1 (weights need not sum to 1). */
export function normalise(index: readonly number[], weights: readonly number[]): number[] {
  const w = weights.reduce((s, x) => s + x, 0)
  const mean = w > 0 ? index.reduce((s, x, i) => s + x * weights[i], 0) / w : index.reduce((s, x) => s + x, 0) / (index.length || 1)
  return mean > 0 ? index.map((x) => x / mean) : index.map(() => 1)
}

/**
 * The 90 % interval of a positive quantity estimated from Gamma shapes (lognormal approximation): each shape adds
 * 1 / shape to the variance of its log (a missing shape adds nothing). Returns the factors to multiply the mean by.
 */
export function intervalFactors(shapes: ReadonlyArray<number | null | undefined>): { lo: number; hi: number } {
  const v = shapes.reduce<number>((s, k) => s + (k == null ? 0 : k > 0 ? 1 / k : 1), 0)
  const sd = Math.sqrt(v)
  return { lo: Math.exp(-Z90 * sd), hi: Math.exp(Z90 * sd) }
}

// ── Curves (pure) ────────────────────────────────────────────────────────────────────────────────────────────────

/** One dimension of a pool's curve: per key, its own totals, traffic share, cost-per-click and conversion index. */
export interface Dim {
  own: Totals[]
  share: number[]
  cpc: number[]
  cr: number[]
  /** The Gamma shape of each conversion index (own orders + the prior's weight). */
  shape: number[]
}

/** A pool's curves. Keys: part 0–5 · weekday 0–6 (Sunday first) · hourOfDay 0–23 · block d × 6 + part · hourOfWeek d × 24 + h. */
export interface PoolCurves {
  total: Totals
  /** The pool's hourly (1-day) conversion rate and cost per click; 0 with no clicks. */
  cr: number
  cpc: number
  part: Dim
  weekday: Dim
  hourOfDay: Dim
  block: Dim
  hourOfWeek: Dim
}

function bucket(cells: readonly HourCell[], n: number, keyOf: (c: HourCell) => number): Totals[] {
  const out = Array.from({ length: n }, () => ({ ...ZERO }))
  for (const c of cells) {
    const k = keyOf(c)
    if (k >= 0 && k < n) out[k] = add(out[k], c)
  }
  return out
}

/**
 * One dimension from its own totals and the parent's same dimension; `crPrior` is each key's conversion prior and `a` its
 * weight in orders.
 */
function dim(own: Totals[], level: { cr: number; cpc: number }, parent: Dim | null, crPrior: readonly number[], a = PRIOR_ORDERS): Dim {
  const share = shrinkShares(own.map((t) => t.clicks), parent?.share ?? null)
  const cpc = normalise(own.map((t, i) => shrinkCpcIndex(t.spendCents, t.clicks, level.cpc, parent?.cpc[i] ?? 1)), share)
  const cr = normalise(own.map((t, i) => shrinkIndex(t.orders, t.clicks * level.cr, crPrior[i], a)), share)
  return { own, share, cpc, cr, shape: own.map((t) => Math.max(0, t.orders) + a) }
}

/** A pool's curves from its hourly cells, shrunk toward its parent pool's (null: the market, shrunk toward flat). */
export function poolCurves(cells: readonly HourCell[], parent: PoolCurves | null): PoolCurves {
  const total = totalOf(cells)
  const level = { cr: total.clicks > 0 ? total.orders / total.clicks : 0, cpc: total.clicks > 0 ? total.spendCents / total.clicks : 0 }
  const ones = (n: number) => Array.from({ length: n }, () => 1)
  const part = dim(bucket(cells, PARTS, (c) => partOf(c.hour)), level, parent?.part ?? null, parent?.part.cr ?? ones(PARTS))
  const weekday = dim(bucket(cells, 7, (c) => weekdayOf(c.day)), level, parent?.weekday ?? null, parent?.weekday.cr ?? ones(7))
  const hourOfDay = dim(bucket(cells, 24, (c) => c.hour), level, parent?.hourOfDay ?? null, parent?.hourOfDay.cr ?? ones(24))
  // A block starts from this pool's day part × weekday, times the parent pool's own block residual (its interaction).
  const blockPrior = Array.from({ length: 7 * PARTS }, (_, k) => {
    const d = Math.floor(k / PARTS), p = k % PARTS
    const sep = part.cr[p] * weekday.cr[d]
    const residual = parent ? parent.block.cr[k] / (parent.part.cr[p] * parent.weekday.cr[d] || 1) : 1
    return sep * residual
  })
  const block = dim(bucket(cells, 7 * PARTS, (c) => blockKey(weekdayOf(c.day), partOf(c.hour))), level, parent?.block ?? null, blockPrior, PRIOR_INTERACTION_ORDERS)
  const hourPrior = Array.from({ length: 168 }, (_, k) => {
    const d = Math.floor(k / 24), h = k % 24
    const sep = hourOfDay.cr[h] * weekday.cr[d]
    const residual = parent ? parent.hourOfWeek.cr[k] / (parent.hourOfDay.cr[h] * parent.weekday.cr[d] || 1) : 1
    return sep * residual
  })
  const hourOfWeek = dim(bucket(cells, 168, (c) => hourKey(weekdayOf(c.day), c.hour)), level, parent?.hourOfWeek ?? null, hourPrior, PRIOR_INTERACTION_ORDERS)
  return { total, cr: level.cr, cpc: level.cpc, part, weekday, hourOfDay, block, hourOfWeek }
}

// ── The research (pure) ──────────────────────────────────────────────────────────────────────────────────────────

export interface LevelFacts extends Totals {
  /** Observed 7-day conversion rate, cost per click, ACoS (fractions; null without the denominator). */
  cr: number | null
  cpcCents: number | null
  acos: number | null
  aovCents: number | null
}

/** One 4-hour block of the week, as the painter reads it. */
export interface BlockResearch {
  d: number
  part: number
  own: Totals
  /** The product's (pooled) share of clicks, and its pool's share (what the block would get if served like the pool). */
  clicksShare: number
  pooledClicksShare: number
  /** Cost-per-click index (product pooled) and the pool's own (for a floored block, whose own CPC is the floor's). */
  cpcIndex: number
  pooledCpcIndex: number
  crIndex: number
  /** The Gamma shapes behind the index: the block's own (orders + the interaction prior), its day part's and weekday's. */
  crShape: number
  partShape?: number
  weekdayShape?: number
}

export interface HourResearch {
  d: number
  h: number
  clicks: number
  orders: number
  spendCents: number
  clicksShare: number
  cpcIndex: number
  crIndex: number
}

export interface HoursResearch {
  version: 1
  productId: string
  productName: string | null
  market: string
  timeZone: string
  window: { from: string | null; to: string | null; days: number; weeks: number }
  leftOut: Array<{ day: string; why: string }>
  /** The daily-report level per pool (7-day attribution). */
  level: { product: LevelFacts; category: LevelFacts | null; market: LevelFacts }
  /**
   * The product's expected level: its 7-day conversion rate and order value shrunk to its pool, the Gamma shape of the
   * conversion rate, the expected ACoS, and a week at that level (spend observed; orders and sales expected).
   */
  expected: { cr: number | null; crShape: number; aovCents: number | null; acos: number | null; cpcCents: number | null; week: { spendCents: number; clicks: number; orders: number; salesCents: number } }
  confidence: {
    label: 'high' | 'medium' | 'low'
    thin: boolean
    ordersPer30d: number
    /** How much of the hour curve each pool carries (sums to 1). */
    leansOn: { product: number; category: number; market: number; flat: number }
    words: string
  }
  blocks: BlockResearch[]
  hours: HourResearch[]
  dayParts: Array<{ part: number; clicksShare: number; cpcIndex: number; crIndex: number }>
  weekdays: Array<{ d: number; clicksPerDayIndex: number; cpcIndex: number; crIndex: number }>
  weekend: { clicksPerDay: number | null; cpc: number | null; cr: number | null }
  trend: { span: string | null; clicks: number | null; cpc: number | null; cr: number | null; marketCpc: number | null }
  /** The market's own day (its pool of every campaign): when shoppers click, what a click costs, when they buy. */
  marketDay: { campaigns: number; peakParts: number[]; quietParts: number[]; cpcHighPart: number | null; cpcLowPart: number | null; crBestPart: number | null; crWorstPart: number | null; crCurveSeen: boolean }
  lanes: Array<{ lane: LaneName; clicksShare: number; spendShare: number; cpcCents: number | null; cr: number | null; acos: number | null; topOfSearchSharePct: number | null }>
  /** The share of the product's spend at top of search (0.5 when the placement report holds none — said so). */
  topOfSearchSpendShare: number
  topOfSearchShareKnown: boolean
  sources: ResearchFacts['sources'] & { campaigns: ResearchFacts['campaigns']; categoryName: string | null; productFromShared: boolean }
  /** Plain-language findings with no money in them. */
  summary: string[]
  /** Findings that name money (cost per click, spend): shown only with ad-spend money. */
  money: string[]
}

const levelFacts = (t: Totals): LevelFacts => ({
  ...t,
  cr: t.clicks > 0 ? r4(t.orders / t.clicks) : null,
  cpcCents: t.clicks > 0 ? r2(t.spendCents / t.clicks) : null,
  acos: t.salesCents > 0 ? r4(t.spendCents / t.salesCents) : null,
  aovCents: t.orders > 0 ? r2(t.salesCents / t.orders) : null,
})

const pct = (x: number) => `${Math.round(x * 100)} %`
const signedPct = (ratio: number) => `${ratio >= 1 ? '+' : '−'}${Math.abs(Math.round((ratio - 1) * 100))} %`
const times = (x: number) => `${Number(x.toFixed(2))} ×`
const money = (cents: number) => (cents / 100).toFixed(2)
const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`
const ratio = (a: number, b: number): number | null => (b > 0 && a >= 0 ? a / b : null)
const argmax = (xs: readonly number[]) => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0)
const argmin = (xs: readonly number[]) => xs.reduce((best, x, i) => (x < xs[best] ? i : best), 0)

/** Two parts of the day within 10 % of each other are "about the same". */
const FLAT = 1.1

/** Where the clicks of a day go, in words (a part 10 % above or below an even sixth is a peak or a trough). */
function trafficWords(share: readonly number[], whose: string): string {
  const even = 1 / share.length
  const peak = argmax(share), quiet = argmin(share)
  // Parts within 5 % of the peak share it: two are named, three or more hold steady.
  const tops = share.map((x, i) => ({ x, i })).filter((p) => p.x >= 0.95 * share[peak]).map((p) => p.i)
  const peakWords = share[peak] < FLAT * even ? `${whose} clicks spread evenly over the day`
    : tops.length >= 3 ? `${whose} clicks hold steady over ${tops.length} of the day's six parts`
      : `${whose} clicks peak ${tops.map(partWords).join(' and ')} (${pct(tops.reduce((t, i) => t + share[i], 0))} of them in ${tops.length === 1 ? 'a sixth' : 'a third'} of the day)`
  const quietWords = share[quiet] <= even / FLAT ? `quietest ${partWords(quiet)} (${pct(share[quiet])})` : null
  return quietWords ? `${peakWords}, ${quietWords}` : peakWords
}

/** What a click costs over the day, in words. */
function cpcWords(cpc: readonly number[]): string {
  const hi = argmax(cpc), lo = argmin(cpc)
  return cpc[hi] / Math.max(cpc[lo], 1e-9) < FLAT
    ? 'a click costs about the same all day (within 10 %)'
    : `a click costs most ${partWords(hi)} (${times(cpc[hi])} the day's average) and least ${partWords(lo)} (${times(cpc[lo])})`
}

/** The days per weekday in the window (a weekday seen 4 times in 4 weeks). */
function weekdayCounts(days: readonly string[]): number[] {
  const n = Array.from({ length: 7 }, () => 0)
  for (const d of days) n[weekdayOf(d)]++
  return n
}

/** The research of one product × market from what was read. Pure. */
export function researchHours(f: ResearchFacts): HoursResearch {
  const market = poolCurves(f.hours.market, null)
  const category = f.hours.category ? poolCurves(f.hours.category, market) : null
  const product = poolCurves(f.hours.product, category ?? market)
  const parent = category ?? market
  const days = f.days.length
  const weeks = days / 7

  // The level: 7-day daily reports; the product's rate and order value shrunk to its pool's.
  const lp = levelFacts(f.daily.product)
  const lc = f.daily.category ? levelFacts(f.daily.category) : null
  const lm = levelFacts(f.daily.market)
  const pool = lc && lc.orders > 0 ? lc : lm
  const priorCr = pool.cr && pool.cr > 0 ? pool.cr : null
  const priorAov = pool.aovCents ?? lp.aovCents
  const crHat = priorCr != null
    ? (lp.orders + PRIOR_ORDERS) / (lp.clicks + PRIOR_ORDERS / priorCr)
    : lp.clicks > 0 && lp.orders > 0 ? lp.orders / lp.clicks : null
  const aovHat = priorAov != null ? (lp.salesCents + PRIOR_ORDERS * priorAov) / (lp.orders + PRIOR_ORDERS) : null
  const cpcHat = lp.cpcCents ?? (pool.cpcCents ?? null)
  const acosHat = crHat && aovHat && cpcHat ? cpcHat / (crHat * aovHat) : null
  const weekClicks = weeks > 0 ? lp.clicks / weeks : 0
  const weekSpend = weeks > 0 ? lp.spendCents / weeks : 0
  const weekOrders = crHat != null ? weekClicks * crHat : 0
  const expected = {
    cr: crHat != null ? r4(crHat) : null, crShape: lp.orders + (priorCr != null ? PRIOR_ORDERS : 0), aovCents: aovHat != null ? r2(aovHat) : null,
    acos: acosHat != null ? r4(acosHat) : null, cpcCents: cpcHat,
    week: { spendCents: r2(weekSpend), clicks: r2(weekClicks), orders: r4(weekOrders), salesCents: r2(aovHat != null ? weekOrders * aovHat : 0) },
  }

  // Confidence: the product's orders a 30 days, and how much of the curve each pool carries.
  const ordersPer30d = days > 0 ? (lp.orders * 30) / days : 0
  const thin = ordersPer30d < THIN_ORDERS_PER_30D
  const label: HoursResearch['confidence']['label'] = ordersPer30d >= SOLID_ORDERS_PER_30D ? 'high' : thin ? 'low' : 'medium'
  const weight = (c: PoolCurves) => { const e = c.total.orders; return e / (e + PRIOR_ORDERS * PARTS) }
  const wP = weight(product), wC = category ? weight(category) : 0, wM = weight(market)
  const leansOn = { product: r2(wP), category: r2((1 - wP) * wC), market: r2((1 - wP) * (1 - wC) * wM), flat: 0 }
  leansOn.flat = r2(Math.max(0, 1 - leansOn.product - leansOn.category - leansOn.market))
  const leanWords = [`the product's own data ${pct(leansOn.product)}`, ...(category ? [`its category ${pct(leansOn.category)}`] : []), `the market ${pct(leansOn.market)}`, ...(leansOn.flat >= 0.05 ? [`a flat curve ${pct(leansOn.flat)}`] : [])]
  const confidenceWords = `${label === 'high' ? 'High' : label === 'medium' ? 'Medium' : 'Low'} confidence: ${plural(lp.orders, 'order')} from ${plural(lp.clicks, 'click')} in ${plural(days, 'day')} (about ${Math.round(ordersPer30d * 10) / 10} a 30 days${thin ? ', thin' : ''}); the hour curve leans on ${leanWords.join(', ')}.`

  const blocks: BlockResearch[] = Array.from({ length: 7 * PARTS }, (_, k) => ({
    d: Math.floor(k / PARTS), part: k % PARTS, own: product.block.own[k],
    clicksShare: r4(product.block.share[k]), pooledClicksShare: r4(parent.block.share[k]),
    cpcIndex: r4(product.block.cpc[k]), pooledCpcIndex: r4(parent.block.cpc[k]),
    crIndex: r4(product.block.cr[k]), crShape: product.block.shape[k],
    partShape: product.part.shape[k % PARTS], weekdayShape: product.weekday.shape[Math.floor(k / PARTS)],
  }))
  const hours: HourResearch[] = Array.from({ length: 168 }, (_, k) => ({
    d: Math.floor(k / 24), h: k % 24, clicks: product.hourOfWeek.own[k].clicks, orders: product.hourOfWeek.own[k].orders,
    spendCents: r2(product.hourOfWeek.own[k].spendCents), clicksShare: r4(product.hourOfWeek.share[k]),
    cpcIndex: r4(product.hourOfWeek.cpc[k]), crIndex: r4(product.hourOfWeek.cr[k]),
  }))
  const dayParts = Array.from({ length: PARTS }, (_, p) => ({ part: p, clicksShare: r4(product.part.share[p]), cpcIndex: r4(product.part.cpc[p]), crIndex: r4(product.part.cr[p]) }))
  const perDay = weekdayCounts(f.days)
  const clicksPerDay = product.weekday.share.map((s, d) => (perDay[d] > 0 ? s / perDay[d] : 0))
  const meanPerDay = days > 0 ? 1 / days : 0
  const weekdays = Array.from({ length: 7 }, (_, d) => ({
    d, clicksPerDayIndex: r4(meanPerDay > 0 ? clicksPerDay[d] / meanPerDay : 0), cpcIndex: r4(product.weekday.cpc[d]), crIndex: r4(product.weekday.cr[d]),
  }))
  // Weekend (Saturday, Sunday) against weekdays, click-weighted.
  const group = (ds: number[], key: 'cpc' | 'cr') => {
    const w = ds.reduce((s, d) => s + product.weekday.share[d], 0)
    return w > 0 ? ds.reduce((s, d) => s + product.weekday[key][d] * product.weekday.share[d], 0) / w : null
  }
  const weekendDays = [0, 6], workDays = [1, 2, 3, 4, 5]
  const perDayOf = (ds: number[]) => { const n = ds.reduce((s, d) => s + perDay[d], 0); return n > 0 ? ds.reduce((s, d) => s + product.weekday.share[d], 0) / n : null }
  const weekendClicks = perDayOf(weekendDays), workClicks = perDayOf(workDays)
  const weekend = {
    clicksPerDay: weekendClicks != null && workClicks ? r4(weekendClicks / workClicks) : null,
    cpc: (() => { const a = group(weekendDays, 'cpc'), b = group(workDays, 'cpc'); return a != null && b ? r4(a / b) : null })(),
    cr: (() => { const a = group(weekendDays, 'cr'), b = group(workDays, 'cr'); return a != null && b ? r4(a / b) : null })(),
  }

  // The trend: the last 14 days against the 14 before (7 and 7 below four weeks).
  const half = days >= 28 ? 14 : days >= 14 ? 7 : 0
  const trend: HoursResearch['trend'] = { span: null, clicks: null, cpc: null, cr: null, marketCpc: null }
  if (half) {
    const recentDays = new Set(f.days.slice(-half)), earlierDays = new Set(f.days.slice(-2 * half, -half))
    const sumOf = (cells: readonly HourCell[], set: Set<string>) => totalOf(cells.filter((c) => set.has(c.day)))
    const r = sumOf(f.hours.product, recentDays), e = sumOf(f.hours.product, earlierDays)
    trend.span = `the last ${half} days against the ${half} before`
    trend.clicks = ratio(r.clicks, e.clicks) != null ? r4(r.clicks / e.clicks) : null
    trend.cpc = r.clicks > 0 && e.clicks > 0 && e.spendCents > 0 ? r4((r.spendCents / r.clicks) / (e.spendCents / e.clicks)) : null
    trend.cr = r.orders >= TREND_ORDERS && e.orders >= TREND_ORDERS ? r4((r.orders / r.clicks) / (e.orders / e.clicks)) : null
    const mr = sumOf(f.hours.market, recentDays), me = sumOf(f.hours.market, earlierDays)
    trend.marketCpc = mr.clicks > 0 && me.clicks > 0 && me.spendCents > 0 ? r4((mr.spendCents / mr.clicks) / (me.spendCents / me.clicks)) : null
  }

  // The market's own day: when shoppers click, what a click costs, when they buy.
  const crCurveSeen = market.total.orders >= CURVE_ORDERS
  const byShare = [...market.part.share.keys()].sort((a, b) => market.part.share[b] - market.part.share[a])
  const marketFacts: HoursResearch['marketDay'] = {
    campaigns: f.campaigns.market,
    peakParts: market.total.clicks ? byShare.slice(0, 1) : [],
    quietParts: market.total.clicks ? byShare.slice(-1) : [],
    cpcHighPart: market.total.clicks ? argmax(market.part.cpc) : null,
    cpcLowPart: market.total.clicks ? argmin(market.part.cpc) : null,
    crBestPart: crCurveSeen ? argmax(market.part.cr) : null,
    crWorstPart: crCurveSeen ? argmin(market.part.cr) : null,
    crCurveSeen,
  }

  // The lanes (daily placement report).
  const laneTotal = totalOf(f.lanes)
  const lanes = f.lanes.map((l) => ({
    lane: l.lane, clicksShare: laneTotal.clicks > 0 ? r4(l.clicks / laneTotal.clicks) : 0, spendShare: laneTotal.spendCents > 0 ? r4(l.spendCents / laneTotal.spendCents) : 0,
    cpcCents: l.clicks > 0 ? r2(l.spendCents / l.clicks) : null, cr: l.clicks > 0 ? r4(l.orders / l.clicks) : null, acos: l.salesCents > 0 ? r4(l.spendCents / l.salesCents) : null,
    topOfSearchSharePct: l.topOfSearchSharePct,
  }))
  const tos = lanes.find((l) => l.lane === 'TOP_OF_SEARCH')
  const topOfSearchShareKnown = laneTotal.spendCents > 0
  const topOfSearchSpendShare = topOfSearchShareKnown ? tos?.spendShare ?? 0 : 0.5

  // ── The words ──
  const name = f.productName ? `"${f.productName}"` : 'the product'
  const summary: string[] = []
  const moneyWords: string[] = []
  summary.push(`Research of ${name} in ${f.market}: ${plural(days, 'day')}${days ? ` (${f.days[0]} to ${f.days[days - 1]}, ${f.timeZone})` : ''}, ${plural(f.campaigns.product, 'campaign')} of its own${f.productFromShared ? ' (it has none of its own: its shared campaigns, which advertise other products too)' : ''}, pooled with ${category ? `${plural(f.campaigns.category, 'campaign')} of its category${f.categoryName ? ` "${f.categoryName}"` : ''} and ` : ''}${plural(f.campaigns.market, 'campaign')} of the market.`)
  summary.push(confidenceWords)
  if (f.leftOut.length) summary.push(`Left out: ${plural(f.leftOut.length, 'day')} an armed dated event replaced the week (${[...new Set(f.leftOut.map((x) => x.why))].join('; ')}).`)
  if (market.total.clicks) {
    summary.push(`The market's day: ${trafficWords(market.part.share, 'its')}; ${cpcWords(market.part.cpc)}.`)
    summary.push(crCurveSeen
      ? `Market conversion is best ${partWords(marketFacts.crBestPart!)} (${times(market.part.cr[marketFacts.crBestPart!])} the average) and worst ${partWords(marketFacts.crWorstPart!)} (${times(market.part.cr[marketFacts.crWorstPart!])}), from ${plural(market.total.orders, 'order')} (1-day attribution).`
      : `The market had ${plural(market.total.orders, 'order')} in these hours: too few to see when shoppers buy; the conversion curve stays near flat.`)
  } else {
    summary.push('No Marketing Stream hours reached Nexus for this market in the window: the brain cannot see its day, and paints nothing from it.')
  }
  if (product.total.clicks) {
    const bestP = argmax(product.part.cr), worstP = argmin(product.part.cr)
    const flatCr = product.part.cr[bestP] / Math.max(product.part.cr[worstP], 1e-9) < FLAT
    summary.push(`${f.productName ? `"${f.productName}"` : 'The product'}: ${trafficWords(product.part.share, 'its')}; pooled, ${flatCr ? 'it converts about the same all day' : `it converts best ${partWords(bestP)} (${times(product.part.cr[bestP])}) and worst ${partWords(worstP)} (${times(product.part.cr[worstP])})`}.`)
  }
  if (weekend.clicksPerDay != null || weekend.cr != null) {
    summary.push(`Weekend against weekdays: clicks a day ${weekend.clicksPerDay != null ? signedPct(weekend.clicksPerDay) : 'not known'}, cost per click ${weekend.cpc != null ? signedPct(weekend.cpc) : 'not known'}, conversion ${weekend.cr != null ? `${signedPct(weekend.cr)} (pooled)` : 'not known'}.`)
  }
  if (trend.span) {
    summary.push(`Trend, ${trend.span}: clicks ${trend.clicks != null ? signedPct(trend.clicks) : 'none before'}, cost per click ${trend.cpc != null ? signedPct(trend.cpc) : 'not known'}${trend.marketCpc != null ? ` (the market's ${signedPct(trend.marketCpc)})` : ''}, ${trend.cr != null ? `conversion ${signedPct(trend.cr)}` : `too few orders to tell conversion (fewer than ${TREND_ORDERS} in a half)`}.`)
  }
  if (topOfSearchShareKnown) {
    const rest = lanes.filter((l) => l.lane !== 'TOP_OF_SEARCH')
    const restClicks = rest.reduce((s, l) => s + l.clicksShare, 0)
    const restOrders = f.lanes.filter((l) => l.lane !== 'TOP_OF_SEARCH').reduce((s, l) => s + l.orders, 0)
    const restCr = laneTotal.clicks * restClicks > 0 ? restOrders / (laneTotal.clicks * restClicks) : null
    const tosShare = tos?.topOfSearchSharePct
    summary.push(`Lanes (daily placement report, 7-day attribution): top of search ${pct(tos?.clicksShare ?? 0)} of clicks and ${pct(topOfSearchSpendShare)} of spend${tos?.cr != null && restCr ? `, converting ${times(tos.cr / restCr)} the other lanes` : ''}${tosShare != null ? `; Amazon's top-of-search impression share about ${Math.round(tosShare)} %` : ''}.`)
  } else {
    summary.push('No placement report for its campaigns in the window: the expected effect assumes half the spend is at top of search.')
  }
  summary.push(`Data: ${plural(f.sources.placementGrainHours, 'campaign hour')} from the ad group × placement grain, ${plural(f.sources.campaignGrainHours, 'campaign hour')} from the campaign grain (both with 1-day conversions for the shape); the level from the daily reports (7-day attribution), whose last 7 days still fill.${f.sources.lateStartCells ? ` ${plural(f.sources.lateStartCells, 'cell')} started late (earlier deltas may be missing).` : ''}`)
  if (lp.clicks) moneyWords.push(`The product's level over the window: ${plural(lp.clicks, 'click')}, spend ${money(lp.spendCents)}, ${plural(lp.orders, 'order')}, sales ${money(lp.salesCents)}${lp.acos != null ? `, ACoS ${pct(lp.acos)}` : ''}; expected (pooled) conversion ${expected.cr != null ? `${(expected.cr * 100).toFixed(2)} %` : 'not known'}${expected.acos != null ? `, expected ACoS ${pct(expected.acos)}` : ''}.`)
  if (market.total.clicks && market.cpc > 0) {
    const hi = marketFacts.cpcHighPart!, lo = marketFacts.cpcLowPart!
    moneyWords.push(market.part.cpc[hi] / Math.max(market.part.cpc[lo], 1e-9) < FLAT
      ? `A market click costs about ${money(market.cpc)} all day (hourly data).`
      : `A market click costs ${money(market.cpc * market.part.cpc[hi])} at ${partWords(hi)} and ${money(market.cpc * market.part.cpc[lo])} at ${partWords(lo)} (hourly data).`)
  }

  return {
    version: 1, productId: f.productId, productName: f.productName, market: f.market, timeZone: f.timeZone,
    window: { from: f.days[0] ?? null, to: f.days[days - 1] ?? null, days, weeks: r2(weeks) },
    leftOut: f.leftOut,
    level: { product: lp, category: lc, market: lm },
    expected,
    confidence: { label, thin, ordersPer30d: r2(ordersPer30d), leansOn, words: confidenceWords },
    blocks, hours, dayParts, weekdays, weekend, trend, marketDay: marketFacts, lanes, topOfSearchSpendShare: r4(topOfSearchSpendShare), topOfSearchShareKnown,
    sources: { ...f.sources, campaigns: f.campaigns, categoryName: f.categoryName, productFromShared: !!f.productFromShared },
    summary, money: moneyWords,
  }
}

// ── The loader ───────────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const shiftDay = (day: string, by: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10)
const formatters = new Map<string, Intl.DateTimeFormat>()
/** The local day and hour of an instant in a time zone. */
export function localDayHour(instant: Date, timeZone: string): { day: string; hour: number } {
  let f = formatters.get(timeZone)
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); formatters.set(timeZone, f) }
  const parts = f.formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
}

/** The local days of the research window: the `weeks` × 7 days before today, oldest first. */
export function researchDays(now: Date, timeZone: string, weeks: number): string[] {
  const today = isoDayIn(now, timeZone)
  const n = Math.max(1, Math.min(RESEARCH_WEEKS_MAX, Math.floor(weeks))) * 7
  return Array.from({ length: n }, (_, i) => shiftDay(today, i - n))
}

/** The time zone the research reads in: the plan's, else the market's own, else Rome's. */
export function researchTimeZone(market: string, planTimeZone?: string | null): string {
  if (isKnownTimeZone(planTimeZone)) return planTimeZone.trim()
  return MARKET_TIME_ZONE[market] ?? 'Europe/Rome'
}

interface CampaignRef { id: string; externalCampaignId: string | null }

/** The market's Sponsored Products campaigns (archived left out), at most MAX_POOL_CAMPAIGNS, by id. */
async function marketCampaigns(market: string): Promise<CampaignRef[]> {
  const rows = await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } },
    select: { id: true, marketplace: true, externalCampaignId: true },
    orderBy: { id: 'asc' },
  })
  return rows.filter((c) => strategyMarket(c.marketplace) === market).slice(0, MAX_POOL_CAMPAIGNS).map((c) => ({ id: c.id, externalCampaignId: c.externalCampaignId }))
}

/** The root product's primary category (else its first) and the market campaigns that advertise a product filed under it. */
async function categoryCampaigns(rootId: string, market: CampaignRef[]): Promise<{ name: string | null; ids: Set<string> } | null> {
  const links = await prisma.productCategory.findMany({ where: { productId: rootId }, select: { categoryId: true, isPrimary: true }, orderBy: { categoryId: 'asc' } })
  const link = links.find((l) => l.isPrimary) ?? links[0]
  if (!link) return null
  const { productsUnderCategory, findCategory } = await import('../ads-strategy/load.js')
  const [productIds, found] = await Promise.all([productsUnderCategory(link.categoryId), findCategory(link.categoryId)])
  if (!productIds.length) return { name: found?.name ?? null, ids: new Set() }
  const marketIds = market.map((c) => c.id)
  const ads = await prisma.adProductAd.findMany({
    where: { status: { not: 'ARCHIVED' }, productId: { in: productIds }, adGroup: { status: { not: 'ARCHIVED' }, campaignId: { in: marketIds } } },
    select: { adGroup: { select: { campaignId: true } } },
  })
  return { name: found?.name ?? null, ids: new Set(ads.map((a) => a.adGroup.campaignId)) }
}

type GrainRow = { entityId: string; date: Date; hour: number; impressions: bigint; clicks: bigint; costMicros: bigint; orders: bigint; sales: bigint }

/**
 * The hourly cells of every campaign named, per campaign × local day × hour: the ad group × placement grain where it holds
 * that hour (summed over its placements), else the campaign grain. 1-day conversions from both.
 */
export async function loadCampaignHours(campaigns: readonly CampaignRef[], days: readonly string[], now: Date, timeZone: string): Promise<{ cells: Map<string, Map<string, HourCell>>; placementGrainHours: number; campaignGrainHours: number; lateStartCells: number; negativeCells: number; newestArrivalAt: Date | null }> {
  const out = new Map<string, Map<string, HourCell>>()
  const inWindow = new Set(days)
  const ids = campaigns.map((c) => c.id)
  const empty = { cells: out, placementGrainHours: 0, campaignGrainHours: 0, lateStartCells: 0, negativeCells: 0, newestArrivalAt: null }
  if (!ids.length || !days.length) return empty
  const today = isoDayIn(now, timeZone)
  const pastDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) / DAY_MS)
  const grain = await loadPlacementHours({ campaignIds: ids, now, timeZone, pastDays })
  const put = (campaignId: string, day: string, hour: number, t: Totals) => {
    const m = out.get(campaignId) ?? new Map<string, HourCell>()
    const k = `${day}|${hour}`
    const c = m.get(k) ?? { day, hour, ...ZERO }
    m.set(k, { day, hour, ...add(c, t) })
    out.set(campaignId, m)
  }
  for (const c of grain.cells) {
    if (!inWindow.has(c.day)) continue
    put(c.campaignId, c.day, c.hour, { impressions: c.impressions, clicks: c.clicks, spendCents: c.spendCents, orders: c.orders1d, salesCents: c.sales1dCents })
  }
  const fromGrain = new Set([...out].flatMap(([id, m]) => [...m.keys()].map((k) => `${id}|${k}`)))
  // The campaign grain, for every campaign hour the placement grain does not hold.
  const byExternal = new Map<string, string[]>()
  for (const c of campaigns) if (c.externalCampaignId) byExternal.set(c.externalCampaignId, [...(byExternal.get(c.externalCampaignId) ?? []), c.id])
  let campaignGrainHours = 0
  if (byExternal.size) {
    const rows = await prisma.$queryRaw<GrainRow[]>(Prisma.sql`
      SELECT "entityId", "date", "hour",
             sum("impressions")::bigint AS impressions, sum("clicks")::bigint AS clicks, sum("costMicros")::bigint AS "costMicros",
             sum(COALESCE("orders7d", 0))::bigint AS orders, sum(COALESCE("sales7dCents", 0))::bigint AS sales
        FROM "AmazonAdsHourlyPerformance"
       WHERE "entityType" = 'CAMPAIGN' AND "adProduct" = 'SPONSORED_PRODUCTS'
         AND "entityId" IN (${Prisma.join([...byExternal.keys()])})
         AND "date" >= ${shiftDay(days[0], -1)}::date AND "date" <= ${shiftDay(days[days.length - 1], 1)}::date
       GROUP BY "entityId", "date", "hour"`)
    for (const r of rows) {
      const { day, hour } = localDayHour(new Date(r.date.getTime() + Number(r.hour) * 3_600_000), timeZone)
      if (!inWindow.has(day)) continue
      for (const campaignId of byExternal.get(r.entityId) ?? []) {
        if (fromGrain.has(`${campaignId}|${day}|${hour}`)) continue
        campaignGrainHours++
        // The campaign grain's 7d-named columns hold Amazon's 1-day conversions (design F2).
        put(campaignId, day, hour, { impressions: Number(r.impressions), clicks: Number(r.clicks), spendCents: Number(r.costMicros) / 10_000, orders: Number(r.orders), salesCents: Number(r.sales) })
      }
    }
  }
  return { cells: out, placementGrainHours: fromGrain.size, campaignGrainHours, lateStartCells: grain.lateStartCells, negativeCells: grain.negativeCells, newestArrivalAt: grain.lastArrivalAt }
}

/** The cells of a set of campaigns summed per local day × hour (negative sums read as 0). */
export function poolCells(byCampaign: ReadonlyMap<string, ReadonlyMap<string, HourCell>>, ids: Iterable<string>): HourCell[] {
  const sum = new Map<string, HourCell>()
  for (const id of ids) {
    for (const [k, c] of byCampaign.get(id) ?? []) {
      const s = sum.get(k) ?? { day: c.day, hour: c.hour, ...ZERO }
      sum.set(k, { day: c.day, hour: c.hour, ...add(s, c) })
    }
  }
  return [...sum.values()].map((c) => ({ ...c, impressions: Math.max(0, c.impressions), clicks: Math.max(0, c.clicks), spendCents: Math.max(0, c.spendCents), orders: Math.max(0, c.orders), salesCents: Math.max(0, c.salesCents) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour)
}

type DailyRow = { entityId: string; impressions: bigint; clicks: bigint; costMicros: bigint; orders: bigint; sales: bigint }
type LaneRow = { placement: string; impressions: bigint; clicks: bigint; costMicros: bigint; orders: bigint; sales: bigint; tos: number | null }

/** The daily reports per campaign (7-day attribution) over the window's dates, by Amazon campaign id. */
async function loadDaily(externalIds: readonly string[], days: readonly string[]): Promise<Map<string, Totals>> {
  const out = new Map<string, Totals>()
  if (!externalIds.length || !days.length) return out
  const rows = await prisma.$queryRaw<DailyRow[]>(Prisma.sql`
    SELECT "entityId", sum("impressions")::bigint AS impressions, sum("clicks")::bigint AS clicks, sum("costMicros")::bigint AS "costMicros",
           sum(COALESCE("orders7d", 0))::bigint AS orders, sum(COALESCE("sales7dCents", 0))::bigint AS sales
      FROM "AmazonAdsDailyPerformance"
     WHERE "entityType" = 'CAMPAIGN' AND "adProduct" = 'SPONSORED_PRODUCTS' AND "entityId" IN (${Prisma.join([...externalIds])})
       AND "date" >= ${days[0]}::date AND "date" <= ${days[days.length - 1]}::date
     GROUP BY "entityId"`)
  for (const r of rows) out.set(r.entityId, { impressions: Number(r.impressions), clicks: Number(r.clicks), spendCents: Number(r.costMicros) / 10_000, orders: Number(r.orders), salesCents: Number(r.sales) })
  return out
}

/** The daily placement report of the product's campaigns, per lane, with Amazon's top-of-search share (impression-weighted). */
async function loadLanes(externalIds: readonly string[], days: readonly string[]): Promise<LaneTotals[]> {
  if (!externalIds.length || !days.length) return []
  const rows = await prisma.$queryRaw<LaneRow[]>(Prisma.sql`
    SELECT "placement", sum("impressions")::bigint AS impressions, sum("clicks")::bigint AS clicks, sum("costMicros")::bigint AS "costMicros",
           sum(COALESCE("orders7d", 0))::bigint AS orders, sum(COALESCE("sales7dCents", 0))::bigint AS sales,
           (sum("topOfSearchIS" * "impressions") FILTER (WHERE "topOfSearchIS" IS NOT NULL) / NULLIF(sum("impressions") FILTER (WHERE "topOfSearchIS" IS NOT NULL), 0))::float AS tos
      FROM "AmazonAdsPlacementReport"
     WHERE "campaignId" IN (${Prisma.join([...externalIds])}) AND "date" >= ${days[0]}::date AND "date" <= ${days[days.length - 1]}::date
     GROUP BY "placement"`)
  const byLane = new Map<LaneName, LaneTotals>()
  for (const r of rows) {
    const placement = REPORT_LABEL_TO_PLACEMENT[r.placement] ?? r.placement
    const lane = laneOf(placement)
    const cur = byLane.get(lane) ?? { lane, ...ZERO, topOfSearchSharePct: null }
    const tosPct = r.tos != null ? Number(r.tos) * (Number(r.tos) <= 1 ? 100 : 1) : null
    byLane.set(lane, {
      ...cur, ...add(cur, { impressions: Number(r.impressions), clicks: Number(r.clicks), spendCents: Number(r.costMicros) / 10_000, orders: Number(r.orders), salesCents: Number(r.sales) }),
      topOfSearchSharePct: lane === 'TOP_OF_SEARCH' && tosPct != null ? Math.round(tosPct * 10) / 10 : cur.topOfSearchSharePct,
    })
  }
  const order: LaneName[] = ['TOP_OF_SEARCH', 'REST_OF_SEARCH', 'PRODUCT_PAGE']
  return order.map((l) => byLane.get(l)).filter((l): l is LaneTotals => !!l)
}

/**
 * Read the research facts of one product × market: its campaigns (own, else shared), its category's and the market's,
 * the hourly cells, the daily level and the lanes. A fixed number of queries whatever the number of campaigns. Null when
 * the product has no family root (brain/ownership.ts productFamily).
 */
export async function loadResearchFacts(input: { productId: string; market: string; now: Date; timeZone: string; weeks?: number; leftOut?: Array<{ day: string; why: string }> }): Promise<ResearchFacts | null> {
  const market = strategyMarket(input.market) ?? input.market
  const found = await productCampaigns(input.productId, market)
  if (!found) return null
  const productRow = await prisma.product.findFirst({ where: { id: found.root }, select: { name: true } })
  const own = found.owned.length ? found.owned : found.shared
  const ownIds = new Set(own.map((c) => c.campaignId))
  const allMarket = await marketCampaigns(market)
  // The product's campaigns are read even past the market cap.
  const extra = own.filter((c) => !allMarket.some((m) => m.id === c.campaignId)).map((c) => c.campaignId)
  const extraRows = extra.length ? await prisma.campaign.findMany({ where: { id: { in: extra } }, select: { id: true, externalCampaignId: true } }) : []
  const campaigns = [...allMarket, ...extraRows.map((c) => ({ id: c.id, externalCampaignId: c.externalCampaignId }))]
  const cat = await categoryCampaigns(found.root, campaigns)
  const windowDays = researchDays(input.now, input.timeZone, input.weeks ?? RESEARCH_WEEKS_DEFAULT)
  const leftOut = (input.leftOut ?? []).filter((x) => windowDays.includes(x.day)).sort((a, b) => a.day.localeCompare(b.day))
  const left = new Set(leftOut.map((x) => x.day))
  const days = windowDays.filter((d) => !left.has(d))
  const hours = await loadCampaignHours(campaigns, days, input.now, input.timeZone)
  const extOf = new Map(campaigns.map((c) => [c.id, c.externalCampaignId]))
  const daily = await loadDaily([...new Set(campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x))], days)
  const dailyOf = (ids: Iterable<string>): Totals => {
    const seen = new Set<string>()
    let t = { ...ZERO }
    for (const id of ids) {
      const ext = extOf.get(id)
      if (!ext || seen.has(ext)) continue
      seen.add(ext)
      t = add(t, daily.get(ext) ?? ZERO)
    }
    return t
  }
  const lanes = await loadLanes([...ownIds].map((id) => extOf.get(id)).filter((x): x is string => !!x), days)
  const catIds = cat ? [...cat.ids] : null
  const marketIds = campaigns.map((c) => c.id)
  return {
    productId: found.root, productName: productRow?.name ?? null, market, timeZone: input.timeZone, days, leftOut,
    hours: { product: poolCells(hours.cells, ownIds), category: catIds && catIds.length ? poolCells(hours.cells, catIds) : null, market: poolCells(hours.cells, marketIds) },
    daily: { product: dailyOf(ownIds), category: catIds && catIds.length ? dailyOf(catIds) : null, market: dailyOf(marketIds) },
    lanes,
    categoryName: cat?.name ?? null,
    campaigns: { product: ownIds.size, category: catIds?.length ?? 0, market: marketIds.length },
    productFromShared: !found.owned.length && found.shared.length > 0,
    sources: {
      placementGrainHours: hours.placementGrainHours, campaignGrainHours: hours.campaignGrainHours, lateStartCells: hours.lateStartCells,
      negativeCells: hours.negativeCells, newestArrivalAt: hours.newestArrivalAt?.toISOString() ?? null,
    },
  }
}
