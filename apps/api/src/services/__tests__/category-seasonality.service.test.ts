import { describe, it, expect } from 'vitest'
import {
  buildCategoryIndex,
  seasonalFactorFor,
  type SeasonalIndexMap,
} from '../category-seasonality.service.js'

const occ1 = new Array(12).fill(1) // every month observed once

describe('buildCategoryIndex', () => {
  it('flat demand → flat index ~1.0 and applied when data is sufficient', () => {
    const units = new Array(12).fill(100) // 1200 units, all months
    const r = buildCategoryIndex(units, occ1, 1200)
    expect(r.applied).toBe(true)
    expect(r.shrink).toBe(1)
    for (const f of r.monthly) expect(f).toBeCloseTo(1, 5)
  })

  it('raw index is normalized to mean 1 over observed months', () => {
    const units = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
    const r = buildCategoryIndex(units, occ1, units.reduce((a, b) => a + b, 0))
    const mean = r.monthlyRaw.reduce((a, b) => a + b, 0) / 12
    expect(mean).toBeCloseTo(1, 3)
  })

  it('surfaces a real seasonal peak/trough and stays demand-neutral on average', () => {
    // Spring-peaked, winter-troughed shape (motorcycle-gear-like).
    const units = [10, 12, 40, 90, 95, 70, 30, 35, 75, 80, 45, 12]
    const total = units.reduce((a, b) => a + b, 0)
    const r = buildCategoryIndex(units, occ1, total)
    expect(r.applied).toBe(true)
    const peak = r.monthly.indexOf(Math.max(...r.monthly))
    const trough = r.monthly.indexOf(Math.min(...r.monthly))
    expect([2, 3, 4]).toContain(peak) // Mar–May
    expect([0, 1, 11]).toContain(trough) // Dec–Feb
    // mean stays ~1 → re-shapes WHEN, never inflates the annual total
    const mean = r.monthly.reduce((a, b) => a + b, 0) / 12
    expect(mean).toBeGreaterThan(0.85)
    expect(mean).toBeLessThan(1.15)
  })

  it('GATE: below the unit floor → flat no-op (applied=false)', () => {
    const units = [5, 5, 5, 5, 5, 5, 5, 5, 0, 0, 0, 0] // 40 units < 60
    const r = buildCategoryIndex(units, [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0], 40)
    expect(r.applied).toBe(false)
    expect(r.shrink).toBe(0)
    for (const f of r.monthly) expect(f).toBe(1)
  })

  it('GATE: too few months with data → flat no-op even with many units', () => {
    const units = [500, 600, 700, 0, 0, 0, 0, 0, 0, 0, 0, 0] // 3 months only
    const occ = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    const r = buildCategoryIndex(units, occ, 1800)
    expect(r.monthsWithData).toBe(3)
    expect(r.applied).toBe(false)
    for (const f of r.monthly) expect(f).toBe(1)
  })

  it('SHRINK: partial trust pulls factors toward 1.0', () => {
    const shape = [10, 12, 40, 90, 95, 70, 30, 35, 75, 80, 45, 12]
    const full = buildCategoryIndex(shape, occ1, 6000) // shrink 1
    const partial = buildCategoryIndex(shape, occ1, 300) // shrink 0.5
    expect(partial.shrink).toBeCloseTo(0.5, 5)
    // every partial factor sits strictly between 1.0 and the full factor
    for (let i = 0; i < 12; i++) {
      const distPartial = Math.abs(partial.monthly[i] - 1)
      const distFull = Math.abs(full.monthly[i] - 1)
      expect(distPartial).toBeLessThanOrEqual(distFull + 1e-9)
    }
  })

  it('CLAMP: an extreme month is bounded to [0.4, 2.5]', () => {
    const units = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100000] // Dec spike
    const r = buildCategoryIndex(units, occ1, 100011)
    for (const f of r.monthly) {
      expect(f).toBeGreaterThanOrEqual(0.4)
      expect(f).toBeLessThanOrEqual(2.5)
    }
  })
})

describe('seasonalFactorFor', () => {
  const map: SeasonalIndexMap = new Map([
    ['OUTERWEAR', [0.4, 0.5, 0.9, 1.6, 1.6, 1.3, 0.7, 0.8, 1.3, 1.4, 1.1, 0.5]],
  ])

  it('returns 1.0 for null / unknown product type (neutral)', () => {
    expect(seasonalFactorFor(map, null, new Date(Date.UTC(2026, 3, 15)))).toBe(1)
    expect(seasonalFactorFor(map, 'PANTS', new Date(Date.UTC(2026, 3, 15)))).toBe(1)
  })

  it('looks up the factor by the date UTC month', () => {
    // April = month index 3 → 1.6
    expect(seasonalFactorFor(map, 'OUTERWEAR', new Date(Date.UTC(2026, 3, 1)))).toBe(1.6)
    // January = index 0 → 0.4
    expect(seasonalFactorFor(map, 'OUTERWEAR', new Date(Date.UTC(2026, 0, 20)))).toBe(0.4)
  })
})
