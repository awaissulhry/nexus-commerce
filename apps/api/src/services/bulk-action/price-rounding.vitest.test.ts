/**
 * "Round prices to .99" rounds each price DOWN to the nearest price ending in .99 (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. The built-in template said "Sets to the next .99 below current" and sent
 * `{ adjustmentType: 'ABSOLUTE', value: 99.99 }`: every price in scope became one number. The rounding is now its own
 * PRICING_UPDATE mode, worked in whole cents so a float never moves a price by a cent.
 */
import { describe, expect, it } from 'vitest'
import { ROUND_DOWN_TO_99, roundDownTo99, roundDownTo99Outcome } from './price-rounding.js'

describe('roundDownTo99 — the largest X.99 at or below the price', () => {
  it.each([
    [25.4, 24.99],
    [25.99, 25.99],
    [25, 24.99],
    [25.98, 24.99],
    [26, 25.99],
    [1, 0.99],
    [0.99, 0.99],
    [1.13, 0.99],
    [19.99, 19.99],
    [100, 99.99],
    [1234.56, 1233.99],
    [99999999.99, 99999999.99],
  ])('%s → %s', (price, expected) => {
    expect(roundDownTo99(price)).toBe(expected)
  })

  it('never lands above the price it started from, on every cent from 0.99 to 50.00', () => {
    for (let cents = 99; cents <= 5000; cents++) {
      const price = cents / 100
      const rounded = roundDownTo99(price)!
      expect(rounded).toBeLessThanOrEqual(price)
      expect(Math.round(rounded * 100) % 100).toBe(99)
      // The LARGEST such price: one euro more would be above it.
      expect(rounded + 1).toBeGreaterThan(price)
    }
  })

  it('a price below 0.99 has no X.99 under it: null, never zero or negative', () => {
    expect(roundDownTo99(0.98)).toBeNull()
    expect(roundDownTo99(0.5)).toBeNull()
    expect(roundDownTo99(0)).toBeNull()
    expect(roundDownTo99(-3)).toBeNull()
    expect(roundDownTo99(Number.NaN)).toBeNull()
  })
})

describe('roundDownTo99Outcome — what one row of the job does (the preview and the run share it)', () => {
  it('names the mode as stored in a payload', () => {
    expect(ROUND_DOWN_TO_99).toBe('ROUND_DOWN_TO_99')
  })

  it('a price that rounds down is processed at the rounded price', () => {
    expect(roundDownTo99Outcome(25.4, {})).toEqual({ newPrice: 24.99, status: 'processed' })
    expect(roundDownTo99Outcome(25, {})).toEqual({ newPrice: 24.99, status: 'processed' })
  })

  it('a price that already ends in .99 is skipped and kept: nothing to write', () => {
    expect(roundDownTo99Outcome(25.99, {})).toEqual({ newPrice: 25.99, status: 'skipped' })
  })

  it('a price below 0.99 is skipped and kept', () => {
    expect(roundDownTo99Outcome(0.5, {})).toEqual({ newPrice: 0.5, status: 'skipped' })
    expect(roundDownTo99Outcome(0, {})).toEqual({ newPrice: 0, status: 'skipped' })
  })

  it('honours the minPrice / maxPrice bounds every PRICING_UPDATE honours', () => {
    expect(roundDownTo99Outcome(25.4, { minPrice: 25 })).toEqual({ newPrice: 24.99, status: 'skipped' })
    expect(roundDownTo99Outcome(25.4, { minPrice: 24.99 })).toEqual({ newPrice: 24.99, status: 'processed' })
    expect(roundDownTo99Outcome(25.4, { maxPrice: 20 })).toEqual({ newPrice: 24.99, status: 'skipped' })
    // A bound that is not a number is ignored, as in the other modes.
    expect(roundDownTo99Outcome(25.4, { minPrice: '30' })).toEqual({ newPrice: 24.99, status: 'processed' })
  })
})
