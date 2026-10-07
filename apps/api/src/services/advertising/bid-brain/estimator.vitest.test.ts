/**
 * BID BRAIN BB-1 — the estimator.
 *
 *   decay      a day's weight halves every 30 days; the window drops days at or past its length; 14 days while the
 *              season index moves
 *   strength   the sibling prior's strength is fitBetaPrior's (ads-bayesian-bidding.service.ts), pinned here
 *   pooling    a keyword without clicks takes its parent's rate; a prior is worth ≥ 2 orders of the parent's rate;
 *              zero orders fall smoothly as K·m/(K+c) (0.87 %, K ≈ 230: −8 % after 20 clicks, −33 % after 115)
 *   AOV        borrows 3 orders of the parent's value; the root starts from the listing price
 *   CPC ratio  own with ≥ 10 clicks, else the parent's, else 0.85 — always inside 0.6–1.0
 */
import { describe, expect, it } from 'vitest'
import { fitBetaPrior } from '../ads-bayesian-bidding.service.js'
import { cpcRatio, crLowerBound80, decayWeight, estimate, siblingStrength, weigh, windowDaysFor, type Evidence } from './estimator.js'

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })

describe('decay and window', () => {
  it('halves every 30 days and leaves out days past the window', () => {
    expect(decayWeight(0)).toBe(1)
    expect(decayWeight(30)).toBeCloseTo(0.5)
    expect(decayWeight(60)).toBeCloseTo(0.25)
    const sum = weigh([
      { daysAgo: 0, clicks: 10, orders: 1, salesCents: 8000, costCents: 300 },
      { daysAgo: 30, clicks: 10, orders: 0, salesCents: 0, costCents: 300 },
      { daysAgo: 90, clicks: 1000, orders: 0, salesCents: 0, costCents: 9999 },
    ])
    expect(sum.clicks).toBeCloseTo(15)
    expect(sum.orders).toBeCloseTo(1)
    expect(sum.costCents).toBeCloseTo(450)
    expect(weigh([{ daysAgo: 20, clicks: 4, orders: 0, salesCents: 0, costCents: 0 }], { windowDays: 14 }).clicks).toBe(0)
  })

  it('reads 14 days only while demand moves by more than 15 %', () => {
    expect(windowDaysFor(null)).toBe(90)
    expect(windowDaysFor(1.1)).toBe(90)
    expect(windowDaysFor(1.2)).toBe(14)
    expect(windowDaysFor(0.8)).toBe(14)
  })
})

describe('the sibling prior', () => {
  it('is fitBetaPrior’s strength', () => {
    const cases: Evidence[][] = [
      [],
      [ev(10, 1), ev(20, 0)],
      [ev(100, 2), ev(50, 1), ev(80, 0), ev(30, 1), ev(200, 3), ev(5, 0)],
      [ev(100, 1), ev(100, 1), ev(100, 1), ev(100, 1), ev(100, 1)],
      [ev(10, 9), ev(10, 0), ev(10, 5), ev(10, 1), ev(10, 2)],
    ]
    for (const arms of cases) expect(siblingStrength(arms)).toBeCloseTo(fitBetaPrior(arms).strength, 9)
  })
})

describe('pooling', () => {
  it('gives a keyword without clicks its parent’s rate and order value', () => {
    const e = estimate([
      { level: 'target', evidence: ev(0) },
      { level: 'product', evidence: ev(2300, 20, 162_300, 69_000) },
    ], { listPriceCents: 8990 })
    expect(e.node.cr).toBeCloseTo(e.parent!.cr, 12)
    expect(e.node.aovCents).toBeCloseTo(e.parent!.aovCents!, 9)
    expect(e.basis.level).toBe('product')
    expect(e.confidence).toBeGreaterThan(0.85)
  })

  it('makes a prior worth at least 2 orders of the parent’s rate, and zero orders fall smoothly (0.87 %: K ≈ 230)', () => {
    const parentCr = 20 / 2300
    const chain = (clicks: number) => estimate([
      { level: 'target', evidence: ev(clicks) },
      // A strong market so the product node keeps its own rate (≈ 0.87 %).
      { level: 'product', evidence: ev(2_300_000, 20_000, 162_300_000, 0) },
    ], { rootCr: parentCr })
    const k = chain(0).node.k
    expect(k).toBeCloseTo(2 / chain(0).parent!.cr, 6)
    expect(k).toBeGreaterThan(225)
    expect(k).toBeLessThan(235)
    const m = chain(0).node.cr
    expect(chain(20).node.cr / m).toBeCloseTo(k / (k + 20), 9) // ≈ −8 %
    expect(1 - chain(20).node.cr / m).toBeCloseTo(0.08, 2)
    expect(1 - chain(115).node.cr / m).toBeCloseTo(0.33, 2)
  })

  it('borrows 3 orders of the parent’s value and starts the root from the listing price', () => {
    const e = estimate([{ level: 'market', evidence: ev(100, 1, 5000) }], { listPriceCents: 9000 })
    expect(e.node.aovCents).toBeCloseTo((5000 + 3 * 9000) / 4, 9)
    const none = estimate([{ level: 'market', evidence: ev(100, 0, 0) }])
    expect(none.node.aovCents).toBeNull()
  })

  it('has no confidence without data anywhere, and refuses an empty chain', () => {
    expect(estimate([{ level: 'target', evidence: ev(0) }, { level: 'market', evidence: ev(0) }]).confidence).toBe(0)
    expect(() => estimate([])).toThrow(/empty chain/)
  })

  it('gives a lower bound below the estimate that tightens with clicks', () => {
    const thin = { cr: 0.01, k: 200, clicks: 10 }
    const thick = { cr: 0.01, k: 200, clicks: 100_000 }
    expect(crLowerBound80(thin)).toBeLessThan(0.01)
    expect(crLowerBound80(thick)).toBeGreaterThan(crLowerBound80(thin))
  })
})

describe('CPC ratio', () => {
  it('uses the target’s own with 10 clicks, else the parent’s, else 0.85, inside 0.6–1.0', () => {
    expect(cpcRatio({ clicks: 10, costCents: 220 }, 25)).toBeCloseTo(0.88)
    expect(cpcRatio({ clicks: 3, costCents: 90 }, 25, 0.7)).toBe(0.7)
    expect(cpcRatio({ clicks: 3, costCents: 90 }, 25)).toBe(0.85)
    expect(cpcRatio({ clicks: 50, costCents: 50 }, 25)).toBe(0.6)
    expect(cpcRatio({ clicks: 50, costCents: 5000 }, 25)).toBe(1)
  })
})
