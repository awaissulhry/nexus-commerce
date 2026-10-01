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

describe('roundDownTo99Outcome — the mode\'s own result for one price (the job\'s and the product\'s bounds come after, in pricing-update.ts)', () => {
  it('names the mode as stored in a payload', () => {
    expect(ROUND_DOWN_TO_99).toBe('ROUND_DOWN_TO_99')
  })

  it('a price that rounds down is processed at the rounded price', () => {
    expect(roundDownTo99Outcome(25.4)).toEqual({ newPrice: 24.99, status: 'processed' })
    expect(roundDownTo99Outcome(25)).toEqual({ newPrice: 24.99, status: 'processed' })
  })

  it('a price that already ends in .99 is skipped and kept, and says so', () => {
    expect(roundDownTo99Outcome(25.99)).toEqual({ newPrice: 25.99, status: 'skipped', reason: 'Not changed: the price already ends in .99.' })
  })

  it('a price below 0.99 is skipped and kept, and says so', () => {
    expect(roundDownTo99Outcome(0.5)).toEqual({ newPrice: 0.5, status: 'skipped', reason: 'Not changed: 0.50 is below 0.99, so there is no lower price ending in .99.' })
    expect(roundDownTo99Outcome(0)).toEqual({ newPrice: 0, status: 'skipped', reason: 'Not changed: 0.00 is below 0.99, so there is no lower price ending in .99.' })
  })
})
