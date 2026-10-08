/**
 * BID BRAIN BB-15 — the attribution lag curve (lag-curve.ts), on made-up vintage sequences.
 *
 *   shapes     the prior and the 1d/7d seed: 1 from the attribution window on, half of what is missing each day
 *   points     a copy "at age a" only where a pull was asked at that age: the vintages keep only pulls that changed
 *              something, and a day read at age 0 and again at 30 (the 60-day re-read) says nothing about ages 1–14
 *   fit        many days of a known curve give that curve back; noise gives a monotone curve inside [5 %, 100 %], 1 from
 *              the attribution window (age 7) on; a restatement that lowers a day never pushes a share past 100 %
 *   prior      thin data stays near the seed (or the prior); only a seed or 14 days of vintages make a curve usable
 *   products   a product keeps its own curve only with 30 final orders, pooled toward its market's
 *   maturity   below 40 % a copy is too young (its numbers would be multiplied by more than 2.5); past age 14 it is full
 *   calibrate  a curve fitted without the newest days nowcasts them better than reading the young copy as final
 *
 * Made-up numbers only (the repository is public).
 */
import { describe, expect, it } from 'vitest'
import {
  calibrate, copyAt, dayCopiesOf, fillShares, fitLagCurve, fitProductCurve, isotonic, lagPoints, LAG_AGES, marketPrior,
  maturityOf, MIN_MATURITY, MIN_SHARE, parseShares, priorShares, seedShares, settledFinal, shapeShares, type DayCopies, type LagSeed,
} from './lag-curve.js'
import { CAMPAIGN_REPORT_TYPE_ID } from '../ads-reports.service.js'
import { SP_CAMPAIGN_REPORT } from './lag-curve-store.js'

const W = 7
/** The made-up truth of the synthetic market: what a copy pulled at each age holds of the final. */
const TRUE_L = [0.6, 0.8, 0.9, 0.95, 0.97, 0.99, 1, 1, 1, 1, 1, 1, 1, 1, 1]
const SEED: LagSeed = { orders1d: 70, orders7d: 100, sales1dCents: 560_000, sales7dCents: 800_000, days: 60 }
const monotone = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1])
const T0 = Date.UTC(2026, 6, 1)
const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

/**
 * A campaign day pulled every night at ages 0..7 (BB-13's nightly re-read), each copy holding round(final × truth(age)),
 * kept only when it changed — as the vintage recorder keeps them.
 */
function nightly(dayIndex: number, final: number, truth: readonly number[] = TRUE_L, noise: (a: number) => number = () => 0): DayCopies {
  const start = T0 + dayIndex * DAY
  const copies: Array<DayCopies['copies'][number]> = []
  let last = -1
  for (let a = 0; a <= W; a++) {
    const orders = Math.max(0, Math.round(final * truth[a] + noise(a)))
    if (orders === last) continue
    last = orders
    copies.push({ pulledAt: start + (a + 1) * DAY + 3_600_000, ageDays: a, orders, salesCents: orders * 5000 })
  }
  return { date: iso(start), copies, pulledAges: Array.from({ length: W + 1 }, (_, a) => a) }
}

describe('the prior and the seed', () => {
  it('fill half of what is missing each day and reach 1 at the attribution window', () => {
    const p = priorShares()
    expect(p.orders.slice(0, 8)).toEqual([0.75, 0.875, 0.9375, 0.9688, 0.9844, 0.9922, 0.9961, 1])
    expect(p.orders.slice(W)).toEqual(Array(LAG_AGES - W).fill(1))
    const s = seedShares(SEED)!
    expect(s.orders[0]).toBe(0.7)
    expect(s.sales[0]).toBe(0.7)
    expect(monotone(s.orders) && monotone(s.sales)).toBe(true)
    // Brands and Display keep filling past day 7 and reach 1 at their 14-day window.
    expect(priorShares('SPONSORED_BRANDS').orders[7]).toBeLessThan(1)
    expect(priorShares('SPONSORED_BRANDS').orders[14]).toBe(1)
  })

  it('needs 10 settled orders, and holds a broken ratio inside 30 %–100 %', () => {
    expect(seedShares({ ...SEED, orders7d: 9, orders1d: 6 })).toBeNull()
    expect(seedShares({ ...SEED, orders1d: 1 })!.orders[0]).toBe(0.3)
    expect(seedShares({ ...SEED, orders1d: 150 })!.orders[0]).toBe(1)
    expect(fillShares(Number.NaN, W)[0]).toBe(0.75)
  })
})

describe('points: a copy at an age only where a pull was asked at it', () => {
  it('reads the newest kept copy at or before the age, never one that was not pulled', () => {
    const d = nightly(0, 10)
    // Copies kept at ages 0 (6), 1 (8), 2 (9), 3 (10 = 9.5 rounded) — later pulls changed nothing.
    expect(d.copies.map((c) => [c.ageDays, c.orders])).toEqual([[0, 6], [1, 8], [2, 9], [3, 10]])
    expect(copyAt(d, 5)).toEqual({ orders: 10, salesCents: 50_000 })
    expect(settledFinal(d, W)).toEqual({ orders: 10, salesCents: 50_000, age: 7 })
    // A day read the morning after and again 30 days later (the 60-day re-read): ages 1–14 were never pulled.
    const old: DayCopies = { date: '2026-07-01', copies: [{ pulledAt: 1, ageDays: 0, orders: 3, salesCents: 15_000 }, { pulledAt: 2, ageDays: 30, orders: 5, salesCents: 25_000 }], pulledAges: [0, 30] }
    expect(copyAt(old, 0)).toEqual({ orders: 3, salesCents: 15_000 })
    for (let a = 1; a < LAG_AGES; a++) expect(copyAt(old, a)).toBeNull()
    const pts = lagPoints([old], W)
    expect(pts.byAge[0]).toEqual({ knownOrders: 3, knownSales: 15_000, finalOrders: 5, finalSales: 25_000, campaignDays: 1 })
    expect(pts.byAge.slice(1).every((s) => s.campaignDays === 0)).toBe(true)
  })

  it('leaves out a day not yet settled (no pull at the attribution window)', () => {
    const young: DayCopies = { date: '2026-07-01', copies: [{ pulledAt: 1, ageDays: 0, orders: 3, salesCents: 1 }], pulledAges: [0, 1, 2] }
    expect(settledFinal(young, W)).toBeNull()
    expect(lagPoints([young], W).campaignDays).toBe(0)
  })

  it('takes every age a pull was asked at from the report jobs, per account and day', () => {
    const at = (t: number) => new Date(t)
    const vintages = [
      { profileId: 'P1', market: 'IT', entityId: 'C1', date: at(T0), pulledAt: at(T0 + DAY + 3_600_000), ageDays: 0, orders7d: 2, sales7dCents: 10_000 },
      { profileId: 'P1', market: 'IT', entityId: 'C1', date: at(T0), pulledAt: at(T0 + 3 * DAY + 3_600_000), ageDays: 2, orders7d: 3, sales7dCents: 15_000 },
      { profileId: 'P2', market: 'DE', entityId: 'C9', date: at(T0), pulledAt: at(T0 + DAY + 3_600_000), ageDays: 0, orders7d: 1, sales7dCents: null },
    ]
    // Nightly ranged pulls of the last 8 days for P1 (ages 0..7 of T0), nothing for P2 but its own copy.
    const pulls = Array.from({ length: 8 }, (_, k) => ({ profileId: 'P1', startDate: at(T0 + (k - 7) * DAY), endDate: at(T0 + k * DAY), createdAt: at(T0 + (k + 1) * DAY + 3_600_000) }))
    const byMarket = dayCopiesOf(vintages, pulls)
    const it = byMarket.get('IT')!
    expect(it).toHaveLength(1)
    expect(it[0].pulledAges).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(it[0].copies.map((c) => c.orders)).toEqual([2, 3])
    expect(settledFinal(it[0], W)).toMatchObject({ orders: 3, age: 7 })
    const de = byMarket.get('DE')!
    expect(de[0].pulledAges).toEqual([])
    expect(de[0].copies[0]).toMatchObject({ orders: 1, salesCents: 0 })
  })
})

describe('the fit', () => {
  it('gives a known curve back from many days, monotone, bounded and 1 at age 14', () => {
    const days = Array.from({ length: 60 }, (_, i) => Array.from({ length: 4 }, (_, c) => nightly(i, 20 + ((i + c) % 5) * 5))).flat()
    const curve = fitLagCurve(lagPoints(days, W), marketPrior(SEED), { seed: SEED })
    expect(curve.source).toBe('vintages')
    expect(curve.usable).toBe(true)
    for (let a = 0; a < W; a++) expect(Math.abs(curve.shares.orders[a] - TRUE_L[a])).toBeLessThan(0.02)
    expect(monotone(curve.shares.orders) && monotone(curve.shares.sales)).toBe(true)
    expect(curve.shares.orders[LAG_AGES - 1]).toBe(1)
    expect(curve.basis).toMatchObject({ vintageDays: 60, campaignDays: 240, priorFrom: 'seed', priorOrders: 20 })
    expect(curve.basis.seed).toMatchObject({ ordersShare: 0.7, days: 60 })
  })

  it('holds 1 from the attribution window on (L(7) = 1), even when a late restatement leaves the age-7 copies below the final', () => {
    // Each day pulled nightly at ages 0..7, then once more at age 30 (the 60-day re-read), which found 10 % more orders.
    const restated = (i: number): DayCopies => {
      const d = nightly(i, 20)
      return { ...d, copies: [...d.copies, { pulledAt: T0 + (i + 31) * DAY, ageDays: 30, orders: 22, salesCents: 22 * 5000 }], pulledAges: [...d.pulledAges, 30] }
    }
    const days = Array.from({ length: 30 }, (_, i) => restated(i))
    expect(copyAt(days[0], W)!.orders).toBe(20)
    expect(settledFinal(days[0], W)).toMatchObject({ orders: 22, age: 30 })
    const curve = fitLagCurve(lagPoints(days, W), marketPrior(SEED), { seed: SEED })
    for (let a = W; a < LAG_AGES; a++) {
      expect(curve.shares.orders[a], `orders L(${a})`).toBe(1)
      expect(curve.shares.sales[a], `sales L(${a})`).toBe(1)
    }
    // The ages inside the window are fitted on their own: age 6 reads 20 of the restated 22, not pooled with ages 7..13.
    expect(curve.shares.orders[6]).toBeGreaterThan(0.9)
    expect(curve.shares.orders[6]).toBeLessThan(0.93)
    expect(monotone(curve.shares.orders) && monotone(curve.shares.sales)).toBe(true)
    // A 14-day window (Brands, Display): fitted through age 13, 1 at 14.
    const sb = shapeShares(Array(LAG_AGES).fill(0.9), Array(LAG_AGES).fill(1), 14)
    expect(sb.slice(W, LAG_AGES - 1)).toEqual(Array(LAG_AGES - 1 - W).fill(0.9))
    expect(sb[LAG_AGES - 1]).toBe(1)
    // The default window is Sponsored Products' 7 days.
    expect(shapeShares(Array(LAG_AGES).fill(0.9), Array(LAG_AGES).fill(1)).slice(W)).toEqual(Array(LAG_AGES - W).fill(1))
  })

  it('makes noisy, out-of-order shares monotone and keeps every share inside [5 %, 100 %]', () => {
    // A late restatement lowers some days (the copy at age 2 holds more than the final) and age 4 reads low.
    const noisy = Array.from({ length: 30 }, (_, i) => nightly(i, 10, [0.3, 0.75, 1.15, 0.9, 0.7, 0.95, 1, 1, 1, 1, 1, 1, 1, 1, 1]))
    const curve = fitLagCurve(lagPoints(noisy, W), marketPrior(null))
    expect(monotone(curve.shares.orders)).toBe(true)
    expect(curve.shares.orders.every((x) => x >= MIN_SHARE && x <= 1)).toBe(true)
    expect(curve.shares.orders[2]).toBeLessThanOrEqual(1)
    expect(curve.shares.orders[LAG_AGES - 1]).toBe(1)
  })

  it('pools thin data toward the seed, and toward the prior without one — usable only with a seed or 14 days', () => {
    const thin = [nightly(0, 2, [0.2, 0.2, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), nightly(1, 1)]
    const seeded = fitLagCurve(lagPoints(thin, W), marketPrior(SEED), { seed: SEED })
    expect(seeded.source).toBe('seed')
    expect(seeded.usable).toBe(true)
    // 3 final orders against a seed worth 20: λ = 3/23 — the curve stays within 0.1 of the seed at age 0.
    expect(Math.abs(seeded.shares.orders[0] - 0.7)).toBeLessThan(0.1)
    const unseeded = fitLagCurve(lagPoints(thin, W), marketPrior(null))
    expect(unseeded.source).toBe('prior')
    expect(unseeded.usable).toBe(false)
    expect(Math.abs(unseeded.shares.orders[0] - 0.75)).toBeLessThan(0.15)
    // Nothing at all: the prior itself, not usable.
    const none = fitLagCurve(lagPoints([], W), marketPrior(null))
    expect(none.shares).toEqual(priorShares())
    expect(none.usable).toBe(false)
    // 14 days of vintages and no seed: usable on its own.
    const two = Array.from({ length: 14 }, (_, i) => nightly(i, 4))
    expect(fitLagCurve(lagPoints(two, W), marketPrior(null)).usable).toBe(true)
  })

  it('isotonic pools adjacent violators by weight', () => {
    expect(isotonic([0.5, 0.9, 0.7, 1], [1, 1, 1, 1])).toEqual([0.5, 0.8, 0.8, 1])
    expect(isotonic([0.5, 0.9, 0.7, 1], [1, 3, 1, 1]).map((x) => Math.round(x * 1000) / 1000)).toEqual([0.5, 0.85, 0.85, 1])
  })
})

describe('products', () => {
  it('keep their own curve only with 30 final orders, pooled toward the market', () => {
    const market = fitLagCurve(lagPoints(Array.from({ length: 40 }, (_, i) => nightly(i, 20)), W), marketPrior(SEED), { seed: SEED })
    const slow = [0.3, 0.5, 0.7, 0.85, 0.95, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    expect(fitProductCurve(lagPoints(Array.from({ length: 5 }, (_, i) => nightly(i, 5, slow)), W), market)).toBeNull()
    const own = fitProductCurve(lagPoints(Array.from({ length: 20 }, (_, i) => nightly(i, 5, slow)), W), market)!
    expect(own.usable).toBe(true)
    expect(own.basis.priorFrom).toBe('market')
    // Between the product's own 30 % and the market's 60 % at age 0, nearer its own (100 final orders against 20).
    expect(own.shares.orders[0]).toBeGreaterThan(0.3)
    expect(own.shares.orders[0]).toBeLessThan(0.45)
  })
})

describe('maturity', () => {
  it('refuses a copy below 40 % and reads a copy past the curve as full', () => {
    const shares = { orders: [0.3, 0.5, ...Array(13).fill(1)], sales: [0.35, 0.45, ...Array(13).fill(1)] }
    const m = maturityOf(shares)
    expect(m(0)).toBeNull()
    expect(m(1)).toEqual({ orders: 0.5, sales: 0.45 })
    expect(m(15)).toEqual({ orders: 1, sales: 1 })
    expect(m(40)).toEqual({ orders: 1, sales: 1 })
    expect(MIN_MATURITY).toBeCloseTo(0.4)
    // A sales share below the floor refuses the copy too.
    expect(maturityOf({ orders: [0.6, ...Array(14).fill(1)], sales: [0.3, ...Array(14).fill(1)] })(0)).toBeNull()
  })

  it('checks stored shares before using them', () => {
    const good = priorShares()
    expect(parseShares(good)).toEqual(good)
    expect(parseShares({ orders: good.orders.slice(1), sales: good.sales })).toBeNull()
    expect(parseShares({ orders: [...good.orders].reverse(), sales: good.sales })).toBeNull()
    expect(parseShares({ orders: good.orders.map(() => 0), sales: good.sales })).toBeNull()
    expect(parseShares(null)).toBeNull()
  })
})

describe('calibration', () => {
  it('holds out the newest settled days and nowcasts them better than reading the young copy as final', () => {
    const days = Array.from({ length: 40 }, (_, i) => Array.from({ length: 3 }, (_, c) => nightly(i, 10 + ((i * 7 + c * 3) % 9)))).flat()
    const cal = calibrate(days, marketPrior(SEED), { evalDays: 14, windowDays: W, seed: SEED })!
    expect(cal).toMatchObject({ evalDays: 14, trainDays: 26, source: 'vintages', from: iso(T0 + 26 * DAY), to: iso(T0 + 39 * DAY) })
    expect(cal.ages.map((a) => a.age)).toEqual([0, 1, 2, 3, 4, 5, 6])
    const age0 = cal.ages[0]
    expect(age0.days).toBe(14)
    expect(age0.used).toBe(true)
    expect(age0.maeOrders).toBeLessThan(age0.maeOrdersRaw)
    expect(age0.errorPct!).toBeLessThan(5)
    expect(age0.errorPctRaw!).toBeGreaterThan(35)
    expect(cal.overall.maeOrders).toBeLessThan(cal.overall.maeOrdersRaw)
    expect(calibrate([], marketPrior(SEED), { evalDays: 14, windowDays: W })).toBeNull()
  })
})

describe('the report type the fit reads', () => {
  it('is the Sponsored Products campaign report', () => {
    expect(SP_CAMPAIGN_REPORT).toBe(CAMPAIGN_REPORT_TYPE_ID.SPONSORED_PRODUCTS)
  })
})
