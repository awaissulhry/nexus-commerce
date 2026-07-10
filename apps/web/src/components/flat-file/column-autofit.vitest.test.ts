import { describe, expect, it } from 'vitest'
import { computeAutoFitWidth, AUTOFIT_MIN, AUTOFIT_MAX, AUTOFIT_PADDING } from './column-autofit'

describe('computeAutoFitWidth', () => {
  it('fits to the widest measurement plus padding', () => {
    expect(computeAutoFitWidth([40, 120, 88])).toBe(120 + AUTOFIT_PADDING)
  })

  it('clamps up to the minimum for tiny content', () => {
    expect(computeAutoFitWidth([4, 10])).toBe(AUTOFIT_MIN)
  })

  it('clamps down to the maximum for huge content', () => {
    expect(computeAutoFitWidth([2000])).toBe(AUTOFIT_MAX)
  })

  it('ignores zero / negative / non-finite measurements (skipped rows)', () => {
    expect(computeAutoFitWidth([0, -5, NaN, Infinity, 100])).toBe(100 + AUTOFIT_PADDING)
  })

  it('returns null when nothing was measurable', () => {
    expect(computeAutoFitWidth([])).toBeNull()
    expect(computeAutoFitWidth([0, NaN])).toBeNull()
  })

  it('rounds fractional widths up before padding', () => {
    expect(computeAutoFitWidth([100.2])).toBe(101 + AUTOFIT_PADDING)
  })

  it('honours custom bounds', () => {
    expect(computeAutoFitWidth([500], { max: 300 })).toBe(300)
    expect(computeAutoFitWidth([10], { min: 80 })).toBe(80)
  })
})
