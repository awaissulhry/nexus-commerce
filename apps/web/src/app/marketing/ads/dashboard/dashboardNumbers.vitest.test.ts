/**
 * W3-A — the Dashboard's percents, each read in the unit its endpoint documents (AM-2, AM-3, AM-7, AM-19).
 * Every arm below reproduces a reading the old size-based guess got wrong.
 */
import { describe, expect, it } from 'vitest'
import { marginText, acosText, placementSharePoints, chartPoint, chartAcosText } from './dashboardNumbers'

describe('True margin — PERCENT POINTS from /advertising/summary (AM-7)', () => {
  it('a loss is printed as itself, never multiplied again', () => {
    expect(marginText(-5)).toBe('-5%') // the guess printed -500%
    expect(marginText(-0.4)).toBe('-0%')
  })
  it('a margin at or under 1 % stays small', () => {
    expect(marginText(0.8)).toBe('1%') // the guess printed 80%
    expect(marginText(1)).toBe('1%') // the guess printed 100%
  })
  it('an ordinary margin is unchanged, and no margin is a dash', () => {
    expect(marginText(31.2)).toBe('31%')
    expect(marginText(null)).toBe('—')
    expect(marginText(undefined)).toBe('—')
  })
})

describe('Top movers ACoS — a FRACTION from /advertising/momentum (AM-2)', () => {
  it('an ACoS of 150 % or more is printed as itself, not "2%"', () => {
    expect(acosText(1.6)).toBe('160.00%') // the guess printed 2%
    expect(acosText(2)).toBe('200.00%')
    expect(acosText(1.5)).toBe('150.00%')
  })
  it('ordinary values, and the trends KPI after its points ÷ 100 — at the Ad Manager\u2019s 2 decimals (AM-30)', () => {
    expect(acosText(0.24)).toBe('24.00%')
    expect(acosText(38.02 / 100)).toBe('38.02%') // was "38%" beside the grid's "38.02%"
    expect(acosText(1.2 / 100)).toBe('1.20%') // a 1.2 % ACoS from trends; the guess printed 120%
  })
  it('a row that spent and sold nothing says "no sales", never 0 %', () => {
    expect(acosText(null, 450)).toBe('no sales')
    expect(acosText(undefined, 0)).toBe('—')
  })
})

describe('Placement share — a FRACTION despite the name sharePct (AM-3)', () => {
  it('fills the bar to the real share', () => {
    expect(placementSharePoints(0.62)).toBe(62) // the old code printed Math.round(0.62) = 1
    expect(placementSharePoints(1)).toBe(100)
    expect(placementSharePoints(0.004)).toBe(0)
    expect(placementSharePoints(undefined)).toBe(0)
  })
})

describe('Spend & ACoS chart — a no-sales day is a gap, not 0 % (AM-19)', () => {
  it('keeps ACoS null on a day that spent and sold nothing, and marks it', () => {
    const p = chartPoint({ date: '2026-09-30', adSpendCents: 1234, acos: null })
    expect(p).toEqual({ date: '09-30', spend: 12.34, acos: null, noSales: true })
    expect(chartAcosText(p.acos, p.noSales)).toBe('no sales')
  })
  it('a day with no spend has no ACoS and is not called "no sales"', () => {
    const p = chartPoint({ date: '2026-09-29', adSpendCents: 0, acos: null })
    expect(p.acos).toBeNull()
    expect(p.noSales).toBe(false)
    expect(chartAcosText(p.acos, p.noSales)).toBe('—')
  })
  it('plots a real ACoS in percent points (trends sends points), and its tooltip reads like the grid (AM-30)', () => {
    const p = chartPoint({ date: '2026-09-28', adSpendCents: 500, acos: 38.02 })
    expect(p.acos).toBe(38.02)
    expect(chartAcosText(p.acos, p.noSales)).toBe('38.02%') // was "38%"
  })
})
